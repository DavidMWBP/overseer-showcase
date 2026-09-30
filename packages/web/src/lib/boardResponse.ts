/** Apply board answers in request order, ignoring only answers older than one already applied. */
export function createBoardResponseGate(): (request: number, apply: () => void) => boolean {
  let applied = 0;
  return (request, apply) => {
    if (request <= applied) return false;
    applied = request;
    apply();
    return true;
  };
}
