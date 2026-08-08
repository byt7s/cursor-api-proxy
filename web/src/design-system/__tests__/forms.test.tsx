import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { Button } from "../components/Button";
import { Checkbox } from "../components/Checkbox";
import { FormField } from "../components/FormField";
import { IconButton } from "../components/IconButton";
import { Input } from "../components/Input";
import { PasswordInput } from "../components/PasswordInput";
import { Select } from "../components/Select";
import { Switch } from "../components/Switch";

describe("Button", () => {
  it("exposes variant and size and fires click handlers", async () => {
    const onClick = vi.fn();
    render(
      <Button variant="danger" size="lg" onClick={onClick}>
        Remove
      </Button>,
    );

    const button = screen.getByRole("button", { name: "Remove" });
    expect(button).toHaveAttribute("data-variant", "danger");
    expect(button).toHaveAttribute("data-size", "lg");
    expect(button).toHaveAttribute("type", "button");

    await userEvent.click(button);
    expect(onClick).toHaveBeenCalledTimes(1);
  });

  it("does not fire while disabled", async () => {
    const onClick = vi.fn();
    render(
      <Button disabled onClick={onClick}>
        Save
      </Button>,
    );

    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(onClick).not.toHaveBeenCalled();
  });

  it("blocks interaction and shows a spinner while loading", async () => {
    const onClick = vi.fn();
    render(
      <Button loading onClick={onClick}>
        Add account
      </Button>,
    );

    const button = screen.getByRole("button", { name: /Add account/ });
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("aria-busy", "true");
    expect(button).toHaveAttribute("data-loading", "true");

    await userEvent.click(button);
    expect(onClick).not.toHaveBeenCalled();
  });
});

describe("IconButton", () => {
  it("uses its label as the accessible name", () => {
    render(<IconButton label="Close dialog" icon="x" />);
    expect(screen.getByRole("button", { name: "Close dialog" })).toBeVisible();
  });
});

describe("FormField", () => {
  it("associates the label with the control it wraps", async () => {
    render(
      <FormField label="Account name" help="Shown in the accounts table">
        <Input />
      </FormField>,
    );

    const input = screen.getByLabelText(/Account name/);
    await userEvent.type(input, "work");
    expect(input).toHaveValue("work");
    expect(input).toHaveAccessibleDescription("Shown in the accounts table");
    expect(input).not.toHaveAttribute("aria-invalid");
  });

  it("marks the control invalid and announces the error", () => {
    render(
      <FormField label="API key" error="API key is required" required>
        <Input />
      </FormField>,
    );

    const input = screen.getByLabelText(/API key/);
    expect(input).toHaveAttribute("aria-invalid", "true");
    expect(input).toHaveAccessibleDescription("API key is required");
    expect(screen.getByRole("alert")).toHaveTextContent("API key is required");
  });
});

describe("PasswordInput", () => {
  it("masks the value until the reveal toggle is pressed", async () => {
    render(<PasswordInput aria-label="Dashboard key" defaultValue="crsr_secret" />);

    const input = screen.getByLabelText("Dashboard key");
    expect(input).toHaveAttribute("type", "password");

    await userEvent.click(screen.getByRole("button", { name: "Show value" }));
    expect(input).toHaveAttribute("type", "text");

    await userEvent.click(screen.getByRole("button", { name: "Hide value" }));
    expect(input).toHaveAttribute("type", "password");
  });
});

describe("Select", () => {
  it("reports the chosen value", async () => {
    const onValueChange = vi.fn();
    render(
      <Select
        aria-label="Tail size"
        value="80"
        onValueChange={onValueChange}
        options={[
          { value: "80", label: "80 lines" },
          { value: "200", label: "200 lines" },
        ]}
      />,
    );

    await userEvent.selectOptions(
      screen.getByLabelText("Tail size"),
      "200",
    );
    expect(onValueChange).toHaveBeenCalledWith("200");
  });
});

describe("Checkbox and Switch", () => {
  it("toggles a checkbox through its label", async () => {
    const onChange = vi.fn();
    render(<Checkbox label="Deep clean" onChange={onChange} />);

    await userEvent.click(screen.getByLabelText(/Deep clean/));
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("exposes switch state via role and aria-checked", async () => {
    const onCheckedChange = vi.fn();
    render(
      <Switch checked={false} onCheckedChange={onCheckedChange} label="autoscroll" />,
    );

    const toggle = screen.getByRole("switch", { name: "autoscroll" });
    expect(toggle).toHaveAttribute("aria-checked", "false");

    await userEvent.click(toggle);
    expect(onCheckedChange).toHaveBeenCalledWith(true);
  });
});
