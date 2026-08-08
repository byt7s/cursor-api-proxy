import { useState, type FormEvent } from "react";

import {
  Alert,
  Badge,
  Button,
  Card,
  CardBody,
  CardHeader,
  ConfirmDialog,
  FormField,
  Grid,
  Inline,
  InlineCode,
  Input,
  PageHeader,
  PasswordInput,
  Stack,
  Table,
  Textarea,
  type TableColumn,
} from "../design-system";
import { useApiResource, useAsyncAction, usePolling, useSettings } from "../hooks";
import { api } from "../lib/api";
import { formatDash, shortenAccountDir } from "../lib/format";
import type { AccountReport, AccountsReport } from "../lib/types";

function authBadge(account: AccountReport) {
  if (!account.authenticated) return <Badge tone="danger">unauthenticated</Badge>;
  if (account.authMethod === "api-key") return <Badge tone="info">API key</Badge>;
  return (
    <Badge tone="success">{account.hasApiKey ? "CLI + key" : "CLI"}</Badge>
  );
}

function usageCell(account: AccountReport) {
  const models = account.usage?.models ?? [];
  if (models.length > 0) {
    const premium = models.find((m) => m.id === "gpt-4") ?? models[0];
    const used = premium.numRequests ?? 0;
    const limit = premium.maxRequestUsage;
    return (
      <span>{limit === null || limit === undefined ? `${used} used` : `${used} / ${limit}`}</span>
    );
  }
  if (account.usageError === "api_key_unsupported") {
    return <Badge tone="neutral">n/a for API key</Badge>;
  }
  if (account.usageError) {
    return <Badge tone="warning">{account.usageError}</Badge>;
  }
  return <span>—</span>;
}

export function AccountsPage() {
  const { poll } = useSettings();
  const accounts = useApiResource<AccountsReport>(() => api.accounts());
  const { pending, run } = useAsyncAction();

  const [addName, setAddName] = useState("");
  const [addKey, setAddKey] = useState("");
  const [setKeyName, setSetKeyName] = useState("");
  const [setKeyValue, setSetKeyValue] = useState("");
  const [modelsName, setModelsName] = useState("");
  const [modelsText, setModelsText] = useState("");
  const [formError, setFormError] = useState<string | null>(null);
  const [removing, setRemoving] = useState<string | null>(null);

  usePolling(() => {
    void accounts.reload();
  }, poll.accountsMs);

  async function onAdd(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!addName.trim() || !addKey.trim()) {
      setFormError("Name and API key are required");
      return;
    }
    setFormError(null);
    const result = await run(() => api.addAccount(addName.trim(), addKey.trim()), {
      successMessage: (r) =>
        `Added account ${(r as { name: string }).name}`,
      errorPrefix: "Add failed",
      onSuccess: () => accounts.reload(),
    });
    if (result) {
      setAddName("");
      setAddKey("");
    }
  }

  async function onSetKey(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!setKeyName.trim() || !setKeyValue.trim()) {
      setFormError("Name and API key are required");
      return;
    }
    setFormError(null);
    const result = await run(
      () => api.setAccountKey(setKeyName.trim(), setKeyValue.trim()),
      {
        successMessage: `API key saved for ${setKeyName.trim()}`,
        errorPrefix: "Set key failed",
        onSuccess: () => accounts.reload(),
      },
    );
    if (result) setSetKeyValue("");
  }

  async function onLoadModels(): Promise<void> {
    if (!modelsName.trim()) {
      setFormError("Account name is required");
      return;
    }
    setFormError(null);
    const result = await run(() => api.accountModels(modelsName.trim()), {
      errorPrefix: "Load models failed",
    });
    if (result) {
      setModelsText((result.allowedModels ?? []).join("\n"));
    }
  }

  async function onSaveModels(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!modelsName.trim()) {
      setFormError("Account name is required");
      return;
    }
    setFormError(null);
    const allowedModels = modelsText
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"));
    await run(
      () => api.setAccountModels(modelsName.trim(), allowedModels),
      {
        successMessage: allowedModels.length
          ? `Allowlist saved for ${modelsName.trim()}`
          : `Allowlist cleared for ${modelsName.trim()} (all models allowed)`,
        errorPrefix: "Save models failed",
        onSuccess: () => accounts.reload(),
      },
    );
  }

  async function onRemoveConfirmed(): Promise<void> {
    const name = removing;
    setRemoving(null);
    if (!name) return;
    await run(() => api.removeAccount(name), {
      successMessage: `Removed ${name}`,
      errorPrefix: "Remove failed",
      onSuccess: () => accounts.reload(),
    });
  }

  const columns: Array<TableColumn<AccountReport>> = [
    {
      key: "name",
      header: "Account",
      render: (a) => a.name,
      sortValue: (a) => a.name,
    },
    { key: "auth", header: "Auth", render: authBadge },
    {
      key: "email",
      header: "Email",
      render: (a) => formatDash(a.email),
      sortValue: (a) => a.email ?? "",
    },
    {
      key: "plan",
      header: "Plan",
      render: (a) => formatDash(a.plan ?? a.membershipType),
    },
    { key: "apiKeyName", header: "API key", render: (a) => formatDash(a.apiKeyName) },
    { key: "usage", header: "Usage", render: usageCell },
    {
      key: "models",
      header: "Models",
      render: (a) =>
        a.allowedModels && a.allowedModels.length > 0 ? (
          <span title={a.allowedModels.join(", ")}>
            {a.allowedModels.length} allowed
          </span>
        ) : (
          <Badge tone="neutral">all</Badge>
        ),
    },
    {
      key: "dir",
      header: "Dir",
      render: (a) => (
        <span title={a.configDir}>{shortenAccountDir(a.configDir)}</span>
      ),
    },
    {
      key: "actions",
      header: "",
      align: "end",
      render: (a) => (
        <Button
          size="sm"
          variant="danger"
          disabled={pending}
          onClick={() => setRemoving(a.name)}
        >
          Remove
        </Button>
      ),
    },
  ];

  const rows = accounts.data?.accounts ?? [];

  return (
    <Stack gap={6}>
      <PageHeader
        title="Accounts"
        description="Cursor accounts available to the proxy, their credentials and usage."
        actions={
          <Button
            variant="secondary"
            loading={accounts.loading}
            onClick={() => void accounts.reload()}
          >
            Refresh
          </Button>
        }
      />

      <Alert tone="info" title="Interactive login is CLI-only">
        Browser login cannot drive the Cursor CLI TTY flow. Run{" "}
        <InlineCode>cursor-api-proxy login</InlineCode> in a terminal to add a
        session account. API keys are never displayed after being saved.
      </Alert>

      {accounts.error && (
        <Alert tone="danger" title="Could not load accounts">
          {accounts.error}
        </Alert>
      )}

      <Card>
        <CardHeader
          title="Known accounts"
          description={
            rows.length === 1 ? "1 account" : `${rows.length} accounts`
          }
        />
        <CardBody flush>
          <Table
            columns={columns}
            rows={rows}
            rowKey={(a) => a.name}
            caption="Cursor accounts"
            loading={accounts.initial && accounts.loading}
            emptyTitle="No accounts found"
            emptyDescription="Add an API-key account below, or run cursor-api-proxy login."
          />
        </CardBody>
      </Card>

      {formError && (
        <Alert tone="warning" title="Check the form">
          {formError}
        </Alert>
      )}

      <Grid columns={2} gap={4}>
        <Card>
          <CardHeader
            title="Add API-key account"
            description="Creates a new account directory holding only the key"
          />
          <CardBody>
            <form onSubmit={onAdd}>
              <Stack gap={4}>
                <FormField label="Account name">
                  <Input
                    value={addName}
                    placeholder="work"
                    onChange={(e) => setAddName(e.target.value)}
                  />
                </FormField>
                <FormField
                  label="API key"
                  help="Dashboard API key from cursor.com — starts with crsr_"
                >
                  <PasswordInput
                    value={addKey}
                    placeholder="crsr_…"
                    onChange={(e) => setAddKey(e.target.value)}
                  />
                </FormField>
                <Inline justify="end">
                  <Button type="submit" variant="primary" loading={pending}>
                    Add account
                  </Button>
                </Inline>
              </Stack>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Set key on existing account"
            description="Adds or replaces the API key of an account that already exists"
          />
          <CardBody>
            <form onSubmit={onSetKey}>
              <Stack gap={4}>
                <FormField label="Account name">
                  <Input
                    value={setKeyName}
                    placeholder="work"
                    onChange={(e) => setSetKeyName(e.target.value)}
                  />
                </FormField>
                <FormField label="API key">
                  <PasswordInput
                    value={setKeyValue}
                    placeholder="crsr_…"
                    onChange={(e) => setSetKeyValue(e.target.value)}
                  />
                </FormField>
                <Inline justify="end">
                  <Button type="submit" loading={pending}>
                    Set key
                  </Button>
                </Inline>
              </Stack>
            </form>
          </CardBody>
        </Card>

        <Card>
          <CardHeader
            title="Model allowlist"
            description="One Cursor model id per line in .cursor-bridge-models. Empty = allow all."
          />
          <CardBody>
            <form onSubmit={onSaveModels}>
              <Stack gap={4}>
                <FormField label="Account name">
                  <Input
                    value={modelsName}
                    placeholder="work"
                    onChange={(e) => setModelsName(e.target.value)}
                  />
                </FormField>
                <FormField
                  label="Allowed models"
                  help="Leave empty and save to clear the allowlist"
                >
                  <Textarea
                    rows={5}
                    value={modelsText}
                    placeholder={"composer-2\nsonnet-4.6"}
                    onChange={(e) => setModelsText(e.target.value)}
                  />
                </FormField>
                <Inline justify="end" gap={2}>
                  <Button
                    type="button"
                    variant="secondary"
                    loading={pending}
                    onClick={() => void onLoadModels()}
                  >
                    Load
                  </Button>
                  <Button type="submit" loading={pending}>
                    Save allowlist
                  </Button>
                </Inline>
              </Stack>
            </form>
          </CardBody>
        </Card>
      </Grid>

      <ConfirmDialog
        open={removing !== null}
        destructive
        title="Remove account"
        message={`Remove account "${removing}"? This deletes its local config directory.`}
        confirmLabel="Remove"
        loading={pending}
        onCancel={() => setRemoving(null)}
        onConfirm={() => void onRemoveConfirmed()}
      />
    </Stack>
  );
}
