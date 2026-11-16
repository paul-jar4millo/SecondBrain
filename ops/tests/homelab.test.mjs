import test from "node:test";
import assert from "node:assert/strict";
import net from "node:net";
import dgram from "node:dgram";
import { probe, wake, magicPacket } from "../homelab/pc.mjs";

test("a closed SMB port reports unknown power state", async () => {
  const server = net.createServer();
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  const port = server.address().port;
  await new Promise((r) => server.close(r));
  assert.deepEqual(await probe({ host: "127.0.0.1", port, timeoutMs: 100 }), {
    state: "unknown",
    responding: false,
  });
});

test("an already responding computer never receives a magic packet", async (t) => {
  const tcp = net.createServer((s) => s.end());
  const udp = dgram.createSocket("udp4");
  await new Promise((r) => tcp.listen(0, "127.0.0.1", r));
  await new Promise((r) => udp.bind(0, "127.0.0.1", r));
  t.after(() => {
    tcp.close();
    udp.close();
  });
  let packets = 0;
  udp.on("message", () => packets++);
  const result = await wake({
    host: "127.0.0.1",
    port: tcp.address().port,
    mac: "00:00:5e:00:53:01",
    broadcast: "127.0.0.1",
    wolPort: udp.address().port,
    deadlineMs: 200,
  });
  assert.equal(result.state, "responding");
  assert.equal(result.sent, false);
  assert.equal(packets, 0);
});

test("WoL emits the specified MAC and respects the entire deadline", async (t) => {
  const udp = dgram.createSocket("udp4");
  await new Promise((r) => udp.bind(0, "127.0.0.1", r));
  t.after(() => udp.close());
  const message = new Promise((r) => udp.once("message", r));
  const started = performance.now();
  const result = await wake({
    host: "127.0.0.1",
    port: 1,
    mac: "00:00:5e:00:53:01",
    broadcast: "127.0.0.1",
    wolPort: udp.address().port,
    deadlineMs: 120,
  });
  const packet = await message;
  assert.equal(packet.length, 102);
  assert.equal(packet.subarray(0, 6).toString("hex"), "ffffffffffff");
  for (let i = 0; i < 16; i++)
    assert.equal(
      packet.subarray(6 + i * 6, 12 + i * 6).toString("hex"),
      "00005e005301",
    );
  assert.equal(result.state, "unknown");
  assert.equal(result.sent, true);
  assert.ok(performance.now() - started < 600);
});

test("invalid MAC and unbounded wait are rejected before sending", async () => {
  assert.throws(() => magicPacket("$(command)"), /MAC/);
  await assert.rejects(
    wake({
      host: "127.0.0.1",
      mac: "00:00:5e:00:53:01",
      broadcast: "127.0.0.1",
      deadlineMs: 120001,
    }),
    /plazo/,
  );
});
