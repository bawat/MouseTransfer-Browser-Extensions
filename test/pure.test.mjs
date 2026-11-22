// Pure-logic tests of src/background.js: URL helpers and the capture-window rect matcher.
import test from "node:test";
import assert from "node:assert/strict";
import { loadBackground } from "./harness.mjs";

test("bakeYouTubeTime", async (t) => {
  const h = await loadBackground();
  const bake = h.fn("bakeYouTubeTime");
  const cases = [
    ["https://www.youtube.com/watch?v=X", 87.9, "https://www.youtube.com/watch?v=X&t=87s"],
    ["https://www.youtube.com/watch?v=X&t=30s&list=Y", 95, "https://www.youtube.com/watch?v=X&list=Y&t=95s"],
    ["https://www.youtube.com/watch?t=30&v=X", 95, "https://www.youtube.com/watch?v=X&t=95s"],
    ["https://youtu.be/ID?t=30", 95, "https://youtu.be/ID?t=95s"],
    ["https://youtu.be/ID", 12.2, "https://youtu.be/ID?t=12s"],
    // The time belongs in the query, before a #fragment, and an existing t= in front of the
    // fragment is replaced rather than duplicated.
    ["https://www.youtube.com/watch?v=X#comments", 95, "https://www.youtube.com/watch?v=X&t=95s#comments"],
    ["https://www.youtube.com/watch?v=X&t=30#comments", 95, "https://www.youtube.com/watch?v=X&t=95s#comments"],
    ["https://youtu.be/ID#x", 5, "https://youtu.be/ID?t=5s#x"],
    // t= in YouTube's h/m/s forms is replaced, not left beside the new one.
    ["https://www.youtube.com/watch?v=X&t=1m30s", 95, "https://www.youtube.com/watch?v=X&t=95s"],
    ["https://www.youtube.com/watch?t=1h2m3s&v=X", 95, "https://www.youtube.com/watch?v=X&t=95s"],
    ["https://youtu.be/ID?t=2m", 95, "https://youtu.be/ID?t=95s"],
    ["https://www.youtube.com/watch?v=X&t=2m&list=L", 95, "https://www.youtube.com/watch?v=X&list=L&t=95s"],
    // not a time: left alone
    ["https://www.youtube.com/watch?v=X&tt=5", 95, "https://www.youtube.com/watch?v=X&tt=5&t=95s"],
  ];
  for (const [url, secs, want] of cases) {
    await t.test(url, () => assert.equal(bake(url, secs), want));
  }
});

test("isBlankTabUrl", async () => {
  const h = await loadBackground();
  const blank = h.fn("isBlankTabUrl");
  for (const u of ["", null, undefined, "about:blank", "ABOUT:BLANK", "chrome://newtab/", "chrome://new-tab-page/"]) {
    assert.equal(blank(u), true, String(u));
  }
  for (const u of ["https://example.com/", "about:blankish", "chrome://extensions/", "edge://newtab/"]) {
    assert.equal(blank(u), false, String(u));
  }
});

// findWindowByPxRect: the wrapper sends a Win32 px rect; windows report DIP bounds.
function win(id, l, t, w, h, tabs = 1) {
  return { id, left: l, top: t, width: w, height: h, tabs: Array.from({ length: tabs }, (_, i) => ({ id: id * 100 + i, url: `https://e.com/${id}/${i}` })) };
}

test("findWindowByPxRect: exact match among several windows", async () => {
  const h = await loadBackground({ windows: [win(1, 0, 0, 800, 600), win(2, 100, 50, 1000, 700, 3), win(3, 900, 0, 500, 500)] });
  const w = await h.fn("findWindowByPxRect")(100, 50, 1000, 700);
  assert.equal(w.id, 2);
  assert.equal(w.tabs.length, 3);
});

test("findWindowByPxRect: matches at 150% scale", async () => {
  // DIP bounds 200,100 800x600 at 1.5 => px 300,150 1200x900
  const h = await loadBackground({ windows: [win(1, 0, 0, 640, 480), win(2, 200, 100, 800, 600)] });
  const w = await h.fn("findWindowByPxRect")(300, 150, 1200, 900);
  assert.equal(w.id, 2);
});

test("findWindowByPxRect: several windows, none close -> null", async () => {
  const h = await loadBackground({ windows: [win(1, 0, 0, 800, 600), win(2, 1000, 0, 800, 600)] });
  const w = await h.fn("findWindowByPxRect")(3000, 2000, 400, 300);
  assert.equal(w, null);
});

test("findWindowByPxRect: a single window is taken even when its bounds diverge", async () => {
  const h = await loadBackground({ windows: [win(7, 0, 0, 800, 600)] });
  const w = await h.fn("findWindowByPxRect")(3000, 2000, 400, 300);
  assert.equal(w.id, 7);
});

test("findWindowByPxRect: a zero-size window is not a candidate", async () => {
  // QQ-style phantom 0x0 window beside the real one: the real one must win via the single-window
  // fallback, even though its bounds diverge from the px rect.
  const h = await loadBackground({ windows: [win(1, 150, 110, 1000, 700, 1), win(2, 52, 52, 0, 0, 2)] });
  const w = await h.fn("findWindowByPxRect")(3000, 2000, 400, 300);
  assert.equal(w.id, 1);
  // and the phantom never matches even when the rect is its own
  const w2 = await h.fn("findWindowByPxRect")(52, 52, 0, 0);
  assert.equal(w2.id, 1);
});

test("findWindowByPxRect: identical bounds -> the focused window, never simply the first listed", async () => {
  const a = { ...win(1, 20, 20, 945, 1020, 1), focused: false };
  const b = { ...win(2, 20, 20, 945, 1020, 2), focused: true };
  const h = await loadBackground({ windows: [a, b] });
  const w = await h.fn("findWindowByPxRect")(20, 20, 945, 1020);
  assert.equal(w.id, 2);
});

test("findWindowByPxRect: identical bounds and none focused -> abort", async () => {
  const h = await loadBackground({ windows: [win(1, 20, 20, 945, 1020), win(2, 20, 20, 945, 1020)] });
  const w = await h.fn("findWindowByPxRect")(20, 20, 945, 1020);
  assert.equal(w, null);
  assert.ok(h.dbgLines().some((l) => /2 windows match the dragged rect equally .* none is focused/.test(l)), h.dbgLines().join("\n"));
});

test("findWindowByPxRect: a near-tie (within one DIP per edge) counts as a tie", async () => {
  const a = { ...win(1, 20, 20, 945, 1020), focused: true };
  const b = win(2, 21, 21, 945, 1020); // 2 DIP away in total
  const h = await loadBackground({ windows: [b, a] });
  const w = await h.fn("findWindowByPxRect")(21, 21, 945, 1020); // b is the exact match, a the focused one
  assert.equal(w.id, 1);
});

// GUARD: a clear best match is not affected by the tie rule.
test("findWindowByPxRect: windows far apart are not a tie", async () => {
  const h = await loadBackground({ windows: [win(1, 20, 20, 945, 1020), { ...win(2, 400, 300, 945, 1020), focused: true }] });
  const w = await h.fn("findWindowByPxRect")(20, 20, 945, 1020);
  assert.equal(w.id, 1);
});
