// Smoke test for the static demo build (GitHub Pages): it must load without a
// backend, open in the build's default language and log no console errors.
//   node ops/verify-demo.mjs <url> [expected-lang]
import { chromium } from "playwright";
import { browserExecutable } from "./browser-executable.mjs";

const url = process.argv[2] || "http://127.0.0.1:4173/SecondBrain/";
const expectedLang = process.argv[3] || "en";
const browser = await chromium.launch({
  executablePath: browserExecutable(),
  args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
const errors = [];
try {
  for (const viewport of [
    { width: 1440, height: 900 },
    { width: 390, height: 844 },
  ]) {
    const page = await browser.newPage({ viewport });
    page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("requestfailed", (r) =>
      errors.push(`request failed: ${r.url()} ${r.failure()?.errorText}`),
    );
    await page.goto(url, { waitUntil: "networkidle" });
    const lang = await page.evaluate(() => document.documentElement.lang);
    if (lang !== expectedLang)
      throw new Error(`Expected lang=${expectedLang}, got ${lang}`);
    await page
      .getByText(
        expectedLang === "en"
          ? "Demo · sample data"
          : "Demo · datos de ejemplo",
      )
      .waitFor({ state: "attached", timeout: 20000 });
    if (process.env.DEMO_SCREENSHOTS)
      await page.screenshot({
        path: `${process.env.DEMO_SCREENSHOTS}/demo-${viewport.width}.png`,
      });
    await page.close();
  }
} finally {
  await browser.close();
}
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
console.log(JSON.stringify({ url, lang: expectedLang, ok: true }));
