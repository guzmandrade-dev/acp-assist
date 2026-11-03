// Drive one bridge op through the spike harness and print the result.
// Usage: node /tmp/drive.mjs <op> [jsonArgs]
const port = process.env.PORT || '8790';
const op = process.argv[2];
const args = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const id = `d${Date.now()}`;
const res = await fetch(`http://127.0.0.1:${port}/drive`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ id, op, args }),
});
await res.json();
// poll /state until the matching result lands (ops take up to a few seconds)
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 200));
  const state = await (await fetch(`http://127.0.0.1:${port}/state`)).json();
  if (state.lastResult && state.lastResult.id === id) {
    console.log(JSON.stringify(state.lastResult, null, 1));
    process.exit(0);
  }
}
console.error('TIMEOUT waiting for result of op ' + op);
process.exit(1);
