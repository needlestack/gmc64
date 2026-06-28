const puppeteer = require('puppeteer');
const path = require('path');

async function screenshot() {
    const file = process.argv[2] || 'sound-maker.html';
    const filePath = path.resolve(__dirname, '..', file);
    const outputPath = path.resolve(__dirname, '..', 'screenshot.png');

    const browser = await puppeteer.launch({
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        headless: 'new'
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 800, height: 600 });
    await page.goto(`file://${filePath}`, { waitUntil: 'networkidle0' });

    // Screenshot just the main content area
    await page.screenshot({ path: outputPath, fullPage: false });

    console.log(`Screenshot saved to ${outputPath}`);
    await browser.close();
}

screenshot().catch(console.error);
