import path from 'path';
import pug from 'pug';

export default function handler(req, res) {
    const filePath = path.join(process.cwd(), 'views', 'index.pug');
    const html = pug.renderFile(filePath, {});

    res.setHeader('Content-Type', 'text/html');
    res.status(200).send(html);
}
