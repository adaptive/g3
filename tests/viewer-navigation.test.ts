import { expect, test } from "bun:test";
import { createViewerNavigation, viewerPhotoId, viewerPhotoUrl } from "../src/client/viewer-navigation";

function browserFixture(initial: string) {
  const entries = [{ url: initial, state: { existing: "preserved" } as unknown }];
  let index = 0;
  const listeners = new Map<string, Set<() => void>>();
  const move = (delta: number) => {
    index = Math.max(0, Math.min(entries.length - 1, index + delta));
    for (const listener of listeners.get("popstate") ?? []) listener();
  };
  const browser = {
    location: { get href() { return entries[index].url; } },
    history: {
      get state() { return entries[index].state; },
      pushState(state: unknown, _title: string, url: string) {
        entries.splice(index + 1, Infinity, { url: new URL(url, entries[index].url).href, state });
        index++;
      },
      replaceState(state: unknown, _title: string, url: string) {
        entries[index] = { url: new URL(url, entries[index].url).href, state };
      },
      back: () => move(-1),
    },
    addEventListener(name: string, listener: () => void) {
      if (!listeners.has(name)) listeners.set(name, new Set());
      listeners.get(name)!.add(listener);
    },
    removeEventListener(name: string, listener: () => void) { listeners.get(name)?.delete(listener); },
  };
  return { browser: browser as unknown as Parameters<typeof createViewerNavigation>[0], entries, move };
}

test("photo URLs preserve other query parameters and the gallery scroll anchor", () => {
  expect(viewerPhotoUrl("https://gallery.example/g/event?filter=one#photographs", "photo-2"))
    .toBe("/g/event?filter=one&photo=photo-2#photographs");
  expect(viewerPhotoUrl("https://gallery.example/g/event?photo=photo-2#photographs", null))
    .toBe("/g/event#photographs");
  expect(viewerPhotoId("https://gallery.example/g/event?photo=%3Cscript%3E")).toBeNull();
});

test("Back closes the viewer, Forward restores its last photo, and Close preserves the gallery entry", () => {
  const fixture = browserFixture("https://gallery.example/g/event#photographs");
  let photo: string | null = null;
  const navigation = createViewerNavigation(fixture.browser, (id) => { photo = id; });
  navigation.open("one");
  navigation.open("two");
  expect(photo as string | null).toBe("two");
  expect(fixture.entries).toHaveLength(2);
  expect((fixture.browser.history.state as { existing: string }).existing).toBe("preserved");
  fixture.move(-1);
  expect(photo).toBeNull();
  fixture.move(1);
  expect(photo as string | null).toBe("two");
  navigation.close();
  expect(photo).toBeNull();
  expect(fixture.browser.location.href).toBe("https://gallery.example/g/event#photographs");
  navigation.dispose();
});

test("closing a direct photo link stays in this gallery rather than leaving the site", () => {
  const fixture = browserFixture("https://gallery.example/g/event?photo=one");
  let photo: string | null = "one";
  const navigation = createViewerNavigation(fixture.browser, (id) => { photo = id; });
  navigation.open("two");
  expect(fixture.entries).toHaveLength(1);
  navigation.close();
  expect(photo).toBeNull();
  expect(fixture.browser.location.href).toBe("https://gallery.example/g/event");
  navigation.dispose();
});

test("refreshing a viewer entry keeps its return-to-gallery behavior", () => {
  const fixture = browserFixture("https://gallery.example/g/event");
  const first = createViewerNavigation(fixture.browser, () => {});
  first.open("one");
  first.dispose();
  const refreshed = createViewerNavigation(fixture.browser, () => {});
  refreshed.close();
  expect(fixture.browser.location.href).toBe("https://gallery.example/g/event");
  refreshed.dispose();
});
