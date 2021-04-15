import * as express from 'express';
import * as path from 'path';
import * as fs from 'fs-extra';
import jszip from 'jszip';
import { LevelInfo, PackInfo } from "../../../shared/types";
import { authorize } from "../account";
import { CommentDoc, getCommentInfosForLevel } from "../comment";
import { db, keyValue } from "../globals";
import { MissionDoc, Mission } from "../mission";
import { MissionUpload, ongoingUploads } from "../mission_upload";
import { PackDoc, getPackInfo, createPackThumbnail } from "../pack";
import { app } from "../server";
import { compressAndSendImage } from "./api";

/** Verifies that the accessed level actually exists. */
const verifyLevelId = async (req: express.Request, res: express.Response) => {
	let levelId = Number(req.params.levelId);
	if (!Number.isInteger(levelId)) {
		res.status(400).send("400\nLevel ID has to be an integer.");
		return null;
	}

	let doc = await db.missions.findOne({ _id: levelId });
	if (!doc) {
		res.status(404).send("404\nA level with this ID does not exist.");
		return null;
	}

	return levelId;
};

export const initLevelApi = () => {
	// Get a list of all levels
	app.get('/api/level/list', async (req, res) => {
		let docs = await db.missions.find({}) as MissionDoc[];
		let response: LevelInfo[] = [];

		for (let doc of docs) {
			let mission = Mission.fromDoc(doc);
			response.push(mission.createLevelInfo());
		}

		res.send(response);
	});

	// Get the .zip of a given level
	app.get('/api/level/:levelId/zip', async (req, res) => {
		let levelId = await verifyLevelId(req, res);
		if (levelId === null) return;

		let doc = await db.missions.findOne({ _id: levelId }) as MissionDoc;
		let mission = Mission.fromDoc(doc);

		let assuming = req.query.assuming as string;
		if (!['none', 'gold', 'platinumquest'].includes(assuming)) assuming = 'platinumquest'; // Default to PQ

		let zip = await mission.createZip(assuming as ('none' | 'gold' | 'platinumquest'));
		let stream = zip.generateNodeStream();

		doc.downloads = (doc.downloads ?? 0) + 1;
		await db.missions.update({ _id: levelId }, doc);

		res.set('Content-Type', 'application/zip');
		res.set('Content-Disposition', `attachment; filename="level-${doc._id}.zip"`);
		stream.pipe(res);
	});

	// Get the image thumbnail of a level
	app.get('/api/level/:levelId/image', async (req, res) => {
		let levelId = await verifyLevelId(req, res);
		if (levelId === null) return;

		let doc = await db.missions.findOne({ _id: levelId }) as MissionDoc;
		let mission = Mission.fromDoc(doc);

		let imagePath = mission.getImagePath();
		if (!imagePath) {
			res.status(404).send("This level is missing an image thumbnail.");
			return;
		}

		await compressAndSendImage(path.join(mission.baseDirectory, imagePath), req, res, { width: 640, height: 480 });
	});

	// Get a list of all files a level depends on
	app.get('/api/level/:levelId/dependencies', async (req, res) => {
		let levelId = await verifyLevelId(req, res);
		if (levelId === null) return;

		let doc = await db.missions.findOne({ _id: levelId }) as MissionDoc;
		let mission = Mission.fromDoc(doc);

		let assuming = req.query.assuming as string;
		if (!['none', 'gold', 'platinumquest'].includes(assuming)) assuming = 'platinumquest';

		let normalizedDependencies = mission.getNormalizedDependencies(assuming as ('none' | 'gold' | 'platinumquest'));

		res.send(normalizedDependencies);
	});

	// Get info about a given level. The info format for the level is identical to the one used for the levels in /list.
	app.get('/api/level/:levelId/info', async (req, res) => {
		let levelId = await verifyLevelId(req, res);
		if (levelId === null) return;

		let doc = await db.missions.findOne({ _id: levelId }) as MissionDoc;
		let mission = Mission.fromDoc(doc);

		res.send(mission.createLevelInfo());
	});

	// Get additional info about a given level
	app.get('/api/level/:levelId/extended-info', async (req, res) => {
		let levelId = await verifyLevelId(req, res);
		if (levelId === null) return;

		let doc = await db.missions.findOne({ _id: levelId }) as MissionDoc;
		let mission = Mission.fromDoc(doc);

		res.send(await mission.createExtendedLevelInfo());
	});

	// Get the raw MissionInfo element from the .mis
	app.get('/api/level/:levelId/mission-info', async (req, res) => {
		let levelId = await verifyLevelId(req, res);
		if (levelId === null) return;

		let doc = await db.missions.findOne({ _id: levelId }) as MissionDoc;
		let mission = Mission.fromDoc(doc);

		res.send(mission.info);
	});

	// Get a list of all packs a level appears in
	app.get('/api/level/:levelId/packs', async (req, res) => {
		let levelId = await verifyLevelId(req, res);
		if (levelId === null) return;

		let doc = await db.missions.findOne({ _id: levelId }) as MissionDoc;
		let packDocs = await db.packs.find({ levels: doc._id }) as PackDoc[];
		let packInfos: PackInfo[] = [];
		for (let packDoc of packDocs) {
			packInfos.push(await getPackInfo(packDoc));
		}

		res.send(packInfos);
	});

	// Upload a level archive. This doesn't yet submit it, but causes the processing/verification step.
	app.post('/api/level/upload', async (req, res) => {
		let doc = await authorize(req);
		if (!doc) {
			res.status(401).send("401\nInvalid token.");
			return;
		}

		/** A list of problems with the upload, will be populated later. */
		let problems: string[] = [];
		let zip: jszip;
		let upload: MissionUpload;

		try {
			zip = await jszip.loadAsync(req.body);
		} catch (e) {
			problems.push("The uploaded file couldn't be unzipped.");
		}

		if (zip) {
			try {
				// Start processing the uploaded archive
				upload = new MissionUpload(zip);
				await upload.process();
				problems.push(...upload.problems);
			} catch (e) {
				problems.push("An error occurred during processing.");
			}
		}

		if (problems.length > 0) {
			res.status(400).send({
				status: 'error',
				problems: problems
			});
		} else {
			// Because uploading is not the same as submitting, we simply remember the mission upload in memory for now. Upon submission, we'll actually write it to disk.
			ongoingUploads.set(upload.id, upload);

			res.send({
				status: 'success',
				uploadId: upload.id
			});
		}
	});

	// Submit a previously uploaded mission
	app.post('/api/level/submit', async (req, res) => {
		let doc = await authorize(req);
		if (!doc) {
			res.status(401).send("401\nInvalid token.");
			return;
		}

		let upload = ongoingUploads.get(req.body.uploadId);
		if (!upload) {
			res.status(400).end();
			return;
		}

		if (typeof req.body.remarks !== 'string') {
			res.status(400).end();
			return;
		}

		// Since the upload ID is random, we assume here that whoever holds the upload ID is also authorized to submit it.

		let missionDoc = await upload.submit(doc._id, req.body.remarks);

		res.send({
			levelId: missionDoc._id
		});
	});

	// Edit a previously submitted level, currently only the remarks
	app.patch('/api/level/:levelId/edit', async (req, res) => {
		let doc = await authorize(req);
		if (!doc) {
			res.status(401).send("401\nInvalid token.");
			return;
		}

		let levelId = await verifyLevelId(req, res);
		if (levelId === null) return;

		// Check if the types are correct
		if (req.body.remarks !== null && typeof req.body.remarks !== 'string') {
			res.status(400).end();
			return;
		}

		let missionDoc = await db.missions.findOne({ _id: levelId }) as MissionDoc;

		// Make sure the level was actually uploaded by the one editing it
		if (missionDoc.addedBy !== doc._id) {
			res.status(403).end();
			return;
		}

		missionDoc.remarks = req.body.remarks;
		await db.missions.update({ _id: levelId }, missionDoc);

		res.end();
	});

	// Delete a previous submitted level
	app.delete('/api/level/:levelId/delete', async (req, res) => {
		let doc = await authorize(req);
		if (!doc) {
			res.status(401).send("401\nInvalid token.");
			return;
		}

		let levelId = await verifyLevelId(req, res);
		if (levelId === null) return;

		let missionDoc = await db.missions.findOne({ _id: levelId }) as MissionDoc;

		// Make sure the level was actually uploaded by the one deleting it
		if (missionDoc.addedBy !== doc._id) {
			res.status(403).end();
			return;
		}

		await db.missions.remove({ _id: levelId }, {});

		// Remove the level from all packs that contained it
		let packDocs = await db.packs.find({ levels: levelId }) as PackDoc[];
		for (let packDoc of packDocs) {
			packDoc.levels = packDoc.levels.filter(x => x !== levelId);
			await db.packs.update({ _id: packDoc._id }, packDoc);
			createPackThumbnail(packDoc);
		}

		// Delete all comments for this level
		await db.comments.remove({ forType: 'level', for: levelId }, { multi: true });

		// Delete the level's folder
		await fs.remove(missionDoc.baseDirectory);

		res.end();
	});

	// Add a comment to a level
	app.post('/api/level/:levelId/comment', async (req, res) => {
		let doc = await authorize(req);
		if (!doc) {
			res.status(401).send("401\nInvalid token.");
			return;
		}

		let levelId = await verifyLevelId(req, res);
		if (levelId === null) return;

		// Make sure the type is correct
		if (typeof req.body.content !== 'string' || !req.body.content.trim()) {
			res.status(400).end();
			return;
		}

		let id = keyValue.get('commentId');
		keyValue.set('commentId', id + 1);

		let comment: CommentDoc = {
			_id: id,
			for: levelId,
			forType: 'level',
			author: doc._id,
			time: Date.now(),
			content: req.body.content
		};
		await db.comments.insert(comment);

		// Respond with a list of all comments for that level
		res.send(await getCommentInfosForLevel(levelId));
	});
};