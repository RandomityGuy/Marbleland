import * as path from 'path';
import * as express from 'express';
import * as fs from 'fs-extra';
import { createApp } from '../../shared/app';
import { renderToString } from '@vue/server-renderer';
import { renderHeadToString } from '@vueuse/head';
import serialize from 'serialize-javascript';
import { Util } from './util';

export const app = express();

export const startHTTPServer = (port: number) => {
	const staticFileMiddleware = express.static(path.join(__dirname, '../client'));

	app.get('*', async (req, res, next) => {
		if (!req.url.includes('.') && req.headers.accept.includes('text/html')) {
			let html = await generateHTML(req.url);
			res.set('Content-Type', 'text/html');
			res.send(html);
		} else {
			next();
		}
	});

	app.use(staticFileMiddleware);

	app.listen(port, () => {
		console.log(`Started HTTP server on port ${port}.`);
	});
};

export const generateHTML = async (url: string) => {
	let template = (await fs.readFile(path.join(__dirname, '../client/index.html'))).toString();
	let { app, router, head, store } = createApp();

	router.push(url);
	await router.isReady();

	let rendered = await renderToString(app);
	let { headTags } = renderHeadToString(head);

	template = Util.replaceMultiple(template, {
		'<!-- ssr head -->': headTags,
		'<!-- ssr state -->': `<script>window.INITIAL_STATE = ${serialize(store.state)};</script>`,
		'<!-- ssr body -->': rendered
	});

	return template;
};