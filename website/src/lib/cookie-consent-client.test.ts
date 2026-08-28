import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONSENT_EVENT,
  CONSENT_STORAGE_KEY,
  announceConsentChange,
  hasAcceptedConsent,
  subscribeToConsent,
} from "@/lib/cookie-consent-client";
import { CONSENT_COOKIE_NAME } from "@/lib/cookie-consent-server";

// ---------------------------------------------------------------------------
// THE CONSENT GATE, TESTED ONCE — BEHAVIOURALLY.
//
// Before this module existed, the gate was four byte-identical copies of the
// same `hasAccepted()` across the analytics and pixel components, with the
// storage key redeclared in eight files and the event name in six. What stood
// in for a test was a source-string assertion (`expect(snap).toContain('const
// CONSENT_EVENT = "vanta:cookie-consent"')`) pinning ONE copy of ONE magic
// string in ONE file.
//
// That could never have caught the failure that mattered: change the key or the
// event, miss one pixel file, and that tracker either fires without consent or
// stops honouring a withdrawal — while the test goes on passing, because the
// file it pins was not the file that was missed.
//
// So the rules are asserted here, on the real functions, once for every caller.
// ---------------------------------------------------------------------------

type Listener = () => void;

const listeners = new Map<string, Set<Listener>>();
let store: Record<string, string> | null = {};

function installWindow() {
  listeners.clear();
  store = {};
  (globalThis as unknown as { window: unknown }).window = {
    localStorage: {
      getItem: (key: string) => {
        // `null` store models storage that THROWS: private mode, and some
        // in-app browsers. Absence of a "yes" must read as a no, not a crash.
        if (store === null) throw new Error("storage blocked");
        return key in store ? store[key] : null;
      },
      setItem: (key: string, value: string) => {
        if (store === null) throw new Error("storage blocked");
        store[key] = value;
      },
    },
    addEventListener: (type: string, fn: Listener) => {
      const set = listeners.get(type) ?? new Set<Listener>();
      set.add(fn);
      listeners.set(type, set);
    },
    removeEventListener: (type: string, fn: Listener) => {
      listeners.get(type)?.delete(fn);
    },
    dispatchEvent: (event: { type: string }) => {
      for (const fn of listeners.get(event.type) ?? []) fn();
      return true;
    },
  };
  // The module calls `new Event(...)`; Node's global Event is fine.
}

beforeEach(installWindow);
afterEach(() => {
  delete (globalThis as unknown as { window?: unknown }).window;
});

describe("the one client-side consent gate", () => {
  it("is a NO until the visitor has actively accepted", () => {
    expect(hasAcceptedConsent()).toBe(false);

    store!["something_else"] = "accepted";
    expect(hasAcceptedConsent()).toBe(false);

    store![CONSENT_STORAGE_KEY] = "declined";
    expect(hasAcceptedConsent()).toBe(false);

    store![CONSENT_STORAGE_KEY] = "accepted";
    expect(hasAcceptedConsent()).toBe(true);
  });

  it("treats blocked storage as a refusal, not as consent", () => {
    store = null;
    expect(() => hasAcceptedConsent()).not.toThrow();
    expect(hasAcceptedConsent()).toBe(false);
  });

  it("uses the same name for the localStorage key and the server's cookie", () => {
    // The banner writes both, and the server gate reads the cookie. If these
    // two drifted, the server and the client would disagree about the same
    // visitor's answer.
    expect(CONSENT_STORAGE_KEY).toBe(CONSENT_COOKIE_NAME);
  });

  it("notifies subscribers when the banner announces a change", () => {
    const onChange = vi.fn();
    subscribeToConsent(onChange);

    announceConsentChange();

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("honours a choice made in ANOTHER TAB", () => {
    // A withdrawal that only reached the tab it was made in is not a
    // withdrawal. `storage` is the only signal the other tab produces.
    const onChange = vi.fn();
    subscribeToConsent(onChange);

    (globalThis as unknown as { window: { dispatchEvent: (e: { type: string }) => void } })
      .window.dispatchEvent({ type: "storage" });

    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("unsubscribes from BOTH signals, so an unmounted tracker goes quiet", () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeToConsent(onChange);

    unsubscribe();
    announceConsentChange();
    (globalThis as unknown as { window: { dispatchEvent: (e: { type: string }) => void } })
      .window.dispatchEvent({ type: "storage" });

    expect(onChange).not.toHaveBeenCalled();
  });

  it("announces on the event name the subscribers actually listen for", () => {
    // Negative control for the whole module: if the dispatcher and the listener
    // ever named different events, every assertion above could still pass while
    // accepting the banner did nothing until a full page reload.
    const onChange = vi.fn();
    subscribeToConsent(onChange);

    (globalThis as unknown as { window: { dispatchEvent: (e: { type: string }) => void } })
      .window.dispatchEvent({ type: CONSENT_EVENT });

    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
