// @vitest-environment jsdom
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { Modal } from "../src/components/ui";
vi.mock("../src/core/store", () => ({}));
afterEach(cleanup);
it("handles Escape inside a profile field without dismissing its enclosing tool", async () => {
  HTMLDialogElement.prototype.showModal = function () {
    this.setAttribute("open", "");
  };
  HTMLDialogElement.prototype.close = function () {
    this.removeAttribute("open");
  };
  const closeTool = vi.fn(),
    closeProfile = vi.fn();
  const user = userEvent.setup();
  render(
    <Modal title="Herramientas" onClose={closeTool} onEscape={closeProfile}>
      <label>
        Encargo
        <input />
      </label>
    </Modal>,
  );
  await user.click(screen.getByLabelText("Encargo"));
  await user.keyboard("{Escape}");
  expect(closeProfile).toHaveBeenCalledOnce();
  expect(closeTool).not.toHaveBeenCalled();
  expect(
    screen.getByRole("dialog", { name: "Herramientas" }).hasAttribute("open"),
  ).toBe(true);
});
