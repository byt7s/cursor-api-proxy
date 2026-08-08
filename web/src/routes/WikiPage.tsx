import { useMemo } from "react";
import { marked } from "marked";

import {
  Alert,
  Button,
  Card,
  CardBody,
  PageHeader,
  Skeleton,
  Stack,
} from "../design-system";
import { useApiResource } from "../hooks";
import { api } from "../lib/api";
import styles from "./WikiPage.module.css";

marked.setOptions({ gfm: true, breaks: false });

export function WikiPage() {
  const wiki = useApiResource<string>(() => api.wiki());

  /**
   * The markdown is `docs/WIKI.md` served by this same process, so it is
   * first-party content rather than user input.
   */
  const html = useMemo(() => {
    if (!wiki.data) return "";
    return marked.parse(wiki.data, { async: false });
  }, [wiki.data]);

  return (
    <Stack gap={6}>
      <PageHeader
        title="Wiki"
        description="docs/WIKI.md rendered straight from the running install."
        actions={
          <Button
            variant="secondary"
            loading={wiki.loading}
            onClick={() => void wiki.reload()}
          >
            Reload
          </Button>
        }
      />

      {wiki.error && (
        <Alert tone="danger" title="Could not load the wiki">
          {wiki.error}
        </Alert>
      )}

      <Card>
        <CardBody>
          {wiki.initial && wiki.loading ? (
            <Stack gap={3}>
              <Skeleton height="var(--space-6)" width="40%" />
              <Skeleton height="var(--space-4)" />
              <Skeleton height="var(--space-4)" />
              <Skeleton height="var(--space-4)" width="80%" />
            </Stack>
          ) : (
            <div
              className={styles.prose}
              data-testid="wiki-content"
              // eslint-disable-next-line react/no-danger
              dangerouslySetInnerHTML={{ __html: html }}
            />
          )}
        </CardBody>
      </Card>
    </Stack>
  );
}
