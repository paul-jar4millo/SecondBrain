// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

const api = vi.hoisted(() => vi.fn());
vi.mock("../src/core/store", () => ({ isDemo: false, api }));
vi.mock("../src/core/events", () => ({ subscribeChanges: () => () => {} }));

import {
  useMarkNotificationsSeen,
  useUnreadNotifications,
} from "../src/features/threads/notifications";

function Badge() {
  return <output>{useUnreadNotifications()}</output>;
}
function Threads() {
  useMarkNotificationsSeen();
  return null;
}

afterEach(() => {
  cleanup();
  api.mockReset();
});

it("counts unread notices and opening Threads marks them seen", async () => {
  api.mockImplementation(async (path: string, init?: RequestInit) => {
    if (path === "/notifications")
      return {
        notifications: [{ id: 3 }, { id: 2 }],
        unread: 2,
      };
    expect(path).toBe("/notifications/seen");
    expect(JSON.parse(String(init?.body))).toEqual({ upTo: 3 });
    return { unread: 0 };
  });
  const { rerender } = render(<Badge />);
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("2"));
  rerender(
    <>
      <Badge />
      <Threads />
    </>,
  );
  await waitFor(() => expect(screen.getByRole("status").textContent).toBe("0"));
});
