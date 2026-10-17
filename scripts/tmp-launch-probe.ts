// TMP-MEASURE (item ci-under-1min-study, never merged): does headless Chromium start on a bare runner, with or without install-deps?
import { chromium } from "playwright";
const t0 = performance.now();
for (const [label, opts] of [["playwright chromium-headless-shell", {}], ["preinstalled google-chrome (channel chrome)", { channel: "chrome" as const }]] as const) {
  const began = performance.now();
  try {
    const browser = await chromium.launch(opts);
    const page = await browser.newPage();
    await page.setContent("<p>hello</p>");
    const text = await page.textContent("p");
    console.log(`PROBE ${label}: started and rendered '${text}' in ${(performance.now() - began).toFixed(0)} ms; version ${browser.version()}`);
    await browser.close();
  } catch (e) {
    console.log(`PROBE ${label}: FAILED after ${(performance.now() - began).toFixed(0)} ms: ${String((e as Error).message).split("\n").slice(0, 4).join(" | ")}`);
  }
}
console.log(`PROBE total ${(performance.now() - t0).toFixed(0)} ms`);
