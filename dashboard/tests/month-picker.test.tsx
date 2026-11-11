// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MonthPicker } from "../src/components/MonthPicker";
afterEach(cleanup);
function Harness() {
  const [value, setValue] = useState("2026-11");
  return (
    <>
      <MonthPicker value={value} onChange={setValue} />
      <output>{value}</output>
    </>
  );
}
it("presenta meses en español y conserva el mes al cambiar de año", async () => {
  const user = userEvent.setup();
  render(<Harness />);
  expect(screen.getByRole("option", { name: "noviembre" })).toBeTruthy();
  await user.selectOptions(
    screen.getByLabelText("Mes de los movimientos"),
    "02",
  );
  const year = screen.getByLabelText("Año de los movimientos");
  await user.clear(year);
  await user.type(year, "2024");
  expect(screen.getByRole("status").textContent).toBe("2024-02");
  await user.clear(year);
  await user.tab();
  expect((year as HTMLInputElement).value).toBe("2024");
  expect(screen.getByRole("status").textContent).toBe("2024-02");
});
