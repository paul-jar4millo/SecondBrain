import { existsSync } from "node:fs";

// Windows installs that already have a browser need no `playwright install`.
const INSTALLED = [
  "C:/Program Files/Google/Chrome/Application/chrome.exe",
  "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
];

/**
 * Browser for the verify scripts: BROWSER_EXECUTABLE, then an installed browser.
 * Undefined lets Playwright use its own Chromium.
 */
export const browserExecutable = () =>
  process.env.BROWSER_EXECUTABLE || INSTALLED.find(existsSync);
