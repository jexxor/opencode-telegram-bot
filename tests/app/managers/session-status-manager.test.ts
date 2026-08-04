import { beforeEach, describe, expect, it, vi } from "vitest";
import { sessionStatusManager } from "../../../src/app/managers/session-status-manager.js";

describe("sessionStatusManager", () => {
  beforeEach(() => {
    sessionStatusManager.__resetForTests();
  });

  it("tracks working, access request, and finished states independently", () => {
    sessionStatusManager.registerMany([
      { id: "session-1", title: "One", directory: "/repo" },
      { id: "session-2", title: "Two", directory: "/repo" },
    ]);

    sessionStatusManager.processEvent({
      type: "session.status",
      properties: { sessionID: "session-1", status: { type: "busy" } },
    } as never);
    sessionStatusManager.processEvent({
      type: "permission.asked",
      properties: { sessionID: "session-2", id: "permission-1" },
    } as never);
    sessionStatusManager.processEvent({
      type: "session.idle",
      properties: { sessionID: "session-1" },
    } as never);

    expect(sessionStatusManager.get("session-1")?.status).toBe("finished");
    expect(sessionStatusManager.get("session-2")?.status).toBe("access_request");
  });

  it("notifies dashboard listeners on status changes", () => {
    const onChange = vi.fn();
    sessionStatusManager.setOnChange(onChange);
    sessionStatusManager.register({ id: "session-1", title: "One", directory: "/repo" });
    sessionStatusManager.markWorking("session-1");

    expect(onChange).toHaveBeenLastCalledWith(
      expect.objectContaining({ id: "session-1", status: "working" }),
    );
  });
});
