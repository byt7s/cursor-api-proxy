import {
  render,
  screen,
  waitFor,
  waitForElementToBeRemoved,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";

import { Alert } from "../components/Alert";
import { ConfirmDialog } from "../components/ConfirmDialog";
import { Modal } from "../components/Modal";
import { ToastProvider, useToast } from "../components/Toast";
import { Tooltip } from "../components/Tooltip";

function ModalHarness({ onClose }: { onClose?: () => void }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open
      </button>
      <Modal
        open={open}
        title="Remove account"
        description="This deletes its local config directory."
        onClose={() => {
          setOpen(false);
          onClose?.();
        }}
      >
        Body content
      </Modal>
    </>
  );
}

describe("Modal", () => {
  it("opens as a labelled dialog and closes on Escape", async () => {
    render(<ModalHarness />);

    expect(screen.queryByRole("dialog")).toBeNull();

    await userEvent.click(screen.getByRole("button", { name: "Open" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    expect(dialog).toHaveAccessibleName("Remove account");
    expect(dialog).toHaveAccessibleDescription(
      "This deletes its local config directory.",
    );

    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes when the backdrop is clicked", async () => {
    render(<ModalHarness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    await userEvent.click(screen.getByTestId("modal-backdrop"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });

  it("closes from the header close control", async () => {
    render(<ModalHarness />);
    await userEvent.click(screen.getByRole("button", { name: "Open" }));

    await userEvent.click(screen.getByRole("button", { name: "Close dialog" }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
});

describe("ConfirmDialog", () => {
  it("routes confirm and cancel to the right callbacks", async () => {
    const onConfirm = vi.fn();
    const onCancel = vi.fn();
    render(
      <ConfirmDialog
        open
        destructive
        title="Remove account"
        message='Remove account "work"?'
        confirmLabel="Remove"
        onConfirm={onConfirm}
        onCancel={onCancel}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);

    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    expect(onConfirm).toHaveBeenCalledTimes(1);
  });
});

describe("Toast", () => {
  function ToastHarness() {
    const toast = useToast();
    return (
      <>
        <button type="button" onClick={() => toast.success("Saved", { duration: 50 })}>
          Notify
        </button>
        <button type="button" onClick={() => toast.error("Add failed", { duration: 0 })}>
          Fail
        </button>
      </>
    );
  }

  it("auto-dismisses a toast once its duration elapses", async () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Notify" }));
    const toast = screen.getByText("Saved");
    expect(toast.closest("[data-tone]")).toHaveAttribute("data-tone", "success");

    await waitForElementToBeRemoved(() => screen.queryByText("Saved"));
  });

  it("keeps a zero-duration toast until it is dismissed", async () => {
    render(
      <ToastProvider>
        <ToastHarness />
      </ToastProvider>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Fail" }));
    const toast = screen.getByText("Add failed");
    expect(toast.closest("[data-tone]")).toHaveAttribute("data-tone", "danger");

    await userEvent.click(
      screen.getByRole("button", { name: "Dismiss notification" }),
    );
    expect(screen.queryByText("Add failed")).toBeNull();
  });

  it("throws when used outside a provider", () => {
    function Orphan() {
      useToast();
      return null;
    }
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(() => render(<Orphan />)).toThrow(/ToastProvider/);
    spy.mockRestore();
  });
});

describe("Tooltip and Alert", () => {
  it("describes its trigger while hovered", async () => {
    render(
      <Tooltip label="Dashboard key stored for this tab">
        <button type="button">key set</button>
      </Tooltip>,
    );

    const trigger = screen.getByRole("button", { name: "key set" });
    expect(screen.queryByRole("tooltip")).toBeNull();

    await userEvent.hover(trigger);
    expect(screen.getByRole("tooltip")).toHaveTextContent(
      "Dashboard key stored for this tab",
    );
  });

  it("announces danger alerts with role=alert", () => {
    render(
      <Alert tone="danger" title="Status unavailable">
        Network error
      </Alert>,
    );

    const alert = screen.getByRole("alert");
    expect(alert).toHaveAttribute("data-tone", "danger");
    expect(alert).toHaveTextContent("Status unavailable");
  });
});
