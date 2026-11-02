// Every browser flow-review launches is headless unless CI is "true": a local run never shows a window, a Dock icon or
// takes focus on the machine someone is using. A headful request outside CI is refused with an error naming what asked
// for it; it never falls back to a visible window, and never silently to headless either.

/** Whether this is CI, where a visible browser is allowed (it has no one's screen to take over). */
export const isCI = (env = process.env) => env.CI === 'true';

/** What in these launch options, or the environment, asks for a visible browser. */
export function headfulReasons(options = {}, env = process.env) {
  const why = [];
  if (options.headless === false) why.push('headless: false');
  if (options.devtools) why.push('devtools: true');
  for (const a of options.args ?? []) {
    if (/^--(headed|auto-open-devtools-for-tabs)(=|$)/.test(a) || /^--headless=(false|0|no|off)$/i.test(a)) why.push(`argument ${a}`);
  }
  // Playwright's debug mode launches every browser headful, with its inspector.
  if (env.PWDEBUG) why.push(`PWDEBUG=${env.PWDEBUG}`);
  return why;
}

/** The launch options with headless on by default; throws outside CI when they, or the environment, ask for a window. */
export function assertHeadless(options = {}, env = process.env) {
  const why = headfulReasons(options, env);
  if (why.length && !isCI(env)) {
    throw new Error(`refusing to launch a visible browser outside CI (${why.join(', ')}). flow-review runs browsers headless on your machine; a headful run is allowed only where CI=true.`);
  }
  return { ...options, headless: options.headless ?? true };
}

/** Launches a browser type (Playwright's chromium, say) headless, or headful only in CI. */
export const launchBrowser = async (browserType, options = {}, env = process.env) => browserType.launch(assertHeadless(options, env));
