/** Runs at once, then at most every `ms`; calls in between collapse into one at the end. */
export function throttled(run: () => void, ms: number) {
  let last = -Infinity;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const fire = () => {
    timer = undefined;
    last = Date.now();
    run();
  };
  const call = () => {
    if (timer) return;
    const wait = last + ms - Date.now();
    if (wait <= 0) fire();
    else timer = setTimeout(fire, wait);
  };
  call.cancel = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  return call;
}
