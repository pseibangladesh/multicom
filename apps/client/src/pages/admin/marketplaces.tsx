/**
 * Copyright (c) 2026 Ronan LE MEILLAT - SCTG Development
 * License: AGPL-3.0-or-later
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { useSearchParams } from "react-router-dom";
import {
  Button,
  Card,
  Chip,
  Input,
  Label,
  Modal,
  Table,
  TextField,
} from "@heroui/react";

import DefaultLayout from "@/layouts/default";
import { useSecuredApi } from "@/authentication";
import { getApiBase } from "@/lib/api-base";
import { getBaseURL } from "@/utils/base-url";
import { StatusBadge } from "@/shared/ui/admin/status-badge";
import {
  CONNECTABLE_PLATFORMS,
  OAUTH_RETURN_PARAMS,
  PLATFORM_LABELS,
  REQUIRED_FOR_LISTING,
  buildConfigPatch,
  connectReturnUrl,
  formFromConfig,
  formatServerDate,
  hasRunningJob,
  isConflictError,
  JOB_POLL_INTERVAL_MS,
  missingListingFields,
  oauthReturnMessageKey,
  readOAuthReturn,
  summarizeImport,
  validateConfigForm,
  type ChannelSummary,
  type ConfigForm,
  type ConnectablePlatform,
  type OrderImportResponse,
} from "@/lib/marketplace-admin";

type Notice = { tone: "success" | "danger" | "default"; text: string };

const CHANNEL_STATUS_COLORS = {
  active: "success",
  paused: "warning",
  error: "danger",
} as const;
const JOB_STATUS_COLORS = {
  completed: "success",
  in_progress: "accent",
  pending: "warning",
  failed: "danger",
} as const;

const isConnectable = (p: string): p is ConnectablePlatform =>
  (CONNECTABLE_PLATFORMS as readonly string[]).includes(p);

/** One input of the config form. */
interface FieldSpec {
  key: string;
  labelKey: string;
  hintKey?: string;
  placeholder?: string;
  numeric?: boolean;
  options?: Array<{ value: string; labelKey: string }>;
}

const ETSY_FIELDS: FieldSpec[] = [
  {
    key: "taxonomy_id",
    labelKey: "admin-marketplaces-field-taxonomy-id",
    hintKey: "admin-marketplaces-hint-taxonomy-id",
    placeholder: "1027",
    numeric: true,
  },
  {
    key: "shipping_profile_id",
    labelKey: "admin-marketplaces-field-shipping-profile-id",
    hintKey: "admin-marketplaces-hint-shipping-profile-id",
    numeric: true,
  },
  {
    key: "readiness_state_id",
    labelKey: "admin-marketplaces-field-readiness-state-id",
    hintKey: "admin-marketplaces-hint-readiness-state-id",
    numeric: true,
  },
  {
    key: "return_policy_id",
    labelKey: "admin-marketplaces-field-return-policy-id",
    numeric: true,
  },
  {
    key: "who_made",
    labelKey: "admin-marketplaces-field-who-made",
    options: [
      { value: "", labelKey: "admin-marketplaces-option-default" },
      { value: "i_did", labelKey: "admin-marketplaces-option-i-did" },
      {
        value: "someone_else",
        labelKey: "admin-marketplaces-option-someone-else",
      },
      { value: "collective", labelKey: "admin-marketplaces-option-collective" },
    ],
  },
  {
    key: "when_made",
    labelKey: "admin-marketplaces-field-when-made",
    hintKey: "admin-marketplaces-hint-when-made",
    placeholder: "made_to_order",
  },
  {
    key: "is_supply",
    labelKey: "admin-marketplaces-field-is-supply",
    options: [
      { value: "", labelKey: "admin-marketplaces-option-default" },
      {
        value: "false",
        labelKey: "admin-marketplaces-option-finished-product",
      },
      { value: "true", labelKey: "admin-marketplaces-option-supply" },
    ],
  },
  {
    key: "default_carrier",
    labelKey: "admin-marketplaces-field-default-carrier",
    hintKey: "admin-marketplaces-hint-carrier-etsy",
    placeholder: "usps",
  },
];

const EBAY_FIELDS: FieldSpec[] = [
  {
    key: "category_id",
    labelKey: "admin-marketplaces-field-category-id",
    placeholder: "9355",
  },
  {
    key: "fulfillment_policy_id",
    labelKey: "admin-marketplaces-field-fulfillment-policy-id",
  },
  {
    key: "payment_policy_id",
    labelKey: "admin-marketplaces-field-payment-policy-id",
  },
  {
    key: "return_policy_id",
    labelKey: "admin-marketplaces-field-return-policy-id",
  },
  {
    key: "merchant_location_key",
    labelKey: "admin-marketplaces-field-merchant-location-key",
    placeholder: "default",
  },
  {
    key: "marketplace_id",
    labelKey: "admin-marketplaces-field-marketplace-id",
    placeholder: "EBAY_US",
  },
  {
    key: "content_language",
    labelKey: "admin-marketplaces-field-content-language",
    placeholder: "en-US",
  },
  {
    key: "default_carrier",
    labelKey: "admin-marketplaces-field-default-carrier",
    hintKey: "admin-marketplaces-hint-carrier-ebay",
    placeholder: "USPS",
  },
];

const SELECT_CLASS =
  "px-3 py-2 rounded-lg bg-default-100 border border-default-300 text-sm focus:outline-none focus:ring-2";

export default function MarketplacesPage() {
  const { t } = useTranslation();
  const { getJson, postJson, patchJson } = useSecuredApi();
  const apiBase = getApiBase();
  const [searchParams, setSearchParams] = useSearchParams();

  const [channels, setChannels] = useState<ChannelSummary[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [notice, setNotice] = useState<Notice | null>(null);
  /** "<channelId>:<action>" while a row action runs. */
  const [busy, setBusy] = useState<string | null>(null);

  const [isConnectOpen, setIsConnectOpen] = useState(false);
  const [connecting, setConnecting] = useState<ConnectablePlatform | null>(
    null,
  );

  const [editing, setEditing] = useState<ChannelSummary | null>(null);
  const [form, setForm] = useState<ConfigForm | null>(null);
  const [originalForm, setOriginalForm] = useState<ConfigForm | null>(null);
  const [formErrors, setFormErrors] = useState<Record<string, string>>({});
  const [isSaving, setIsSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  const loadChannels = useCallback(async () => {
    try {
      const resp = await getJson(`${apiBase}/v1/admin/marketplace/channels`);

      setChannels(resp?.channels ?? []);
    } catch (err) {
      console.error("Failed to load marketplace channels", err);
      setNotice({ tone: "danger", text: t("admin-marketplaces-load-failed") });
    } finally {
      setIsLoading(false);
    }
  }, [apiBase, getJson, t]);

  useEffect(() => {
    loadChannels();
  }, []);

  // Queued jobs run in the background; refresh until they settle.
  const jobRunning = hasRunningJob(channels);

  useEffect(() => {
    if (!jobRunning) return;
    const timer = window.setInterval(loadChannels, JOB_POLL_INTERVAL_MS);

    return () => window.clearInterval(timer);
  }, [jobRunning, loadChannels]);

  // Result of the OAuth round trip: show it once, then clean the URL.
  useEffect(() => {
    const ret = readOAuthReturn(searchParams.toString());

    if (!ret) return;
    const platform =
      PLATFORM_LABELS[ret.platform as ConnectablePlatform] ?? ret.platform;

    setNotice({
      tone: ret.result === "connected" ? "success" : "danger",
      text: t(oauthReturnMessageKey(ret), { platform }),
    });
    const next = new URLSearchParams(searchParams);

    for (const k of OAUTH_RETURN_PARAMS) next.delete(k);
    setSearchParams(next, { replace: true });
  }, []);

  // ── Connect ─────────────────────────────────────────────────────────────

  const startConnect = async (
    platform: ConnectablePlatform,
    channelId?: string,
  ) => {
    setConnecting(platform);
    setNotice(null);
    try {
      const resp = await postJson(
        `${apiBase}/v1/marketplace/connect/${platform}`,
        {
          return_to: connectReturnUrl(window.location.origin, getBaseURL()),
          ...(channelId && { channel_id: channelId }),
        },
      );

      if (!resp?.authUrl) throw new Error("No authUrl in response");
      window.location.assign(resp.authUrl);
    } catch (err) {
      console.error(`Failed to start ${platform} connection`, err);
      setIsConnectOpen(false);
      setConnecting(null);
      setNotice({
        tone: "danger",
        text: t("admin-marketplaces-connect-start-failed", {
          platform: PLATFORM_LABELS[platform],
        }),
      });
    }
  };

  // ── Sync actions ────────────────────────────────────────────────────────

  const pullOrders = async (channel: ChannelSummary) => {
    setBusy(`${channel.id}:orders`);
    setNotice(null);
    try {
      const resp = (await postJson(
        `${apiBase}/v1/marketplace/${channel.id}/orders/import`,
        {},
      )) as OrderImportResponse;
      const s = summarizeImport(resp);

      setNotice({
        tone: s.failed > 0 ? "danger" : "success",
        text: t("admin-marketplaces-import-result", s),
      });
    } catch (err) {
      console.error("Order import failed", err);
      setNotice({
        tone: "danger",
        text: t("admin-marketplaces-import-failed"),
      });
    } finally {
      setBusy(null);
      loadChannels();
    }
  };

  const pushProducts = async (channel: ChannelSummary) => {
    setBusy(`${channel.id}:products`);
    setNotice(null);
    try {
      await postJson(
        `${apiBase}/v1/marketplace/${channel.id}/sync/products`,
        {},
      );
      setNotice({ tone: "default", text: t("admin-marketplaces-push-queued") });
    } catch (err) {
      console.error("Queueing product push failed", err);
      setNotice({
        tone: "danger",
        text: t(
          isConflictError(err)
            ? "admin-marketplaces-push-already-running"
            : "admin-marketplaces-push-failed",
        ),
      });
    } finally {
      setBusy(null);
      loadChannels();
    }
  };

  // ── Config editing ──────────────────────────────────────────────────────

  const openEdit = (channel: ChannelSummary) => {
    if (!isConnectable(channel.platform)) return;
    const initial = formFromConfig(channel.platform, channel.config);

    setEditing(channel);
    setForm(initial);
    setOriginalForm(initial);
    setFormErrors({});
    setSaveError(null);
  };

  const closeEdit = () => {
    setEditing(null);
    setForm(null);
    setOriginalForm(null);
  };

  const saveConfig = async () => {
    if (!editing || !form || !originalForm || !isConnectable(editing.platform))
      return;
    const errors = validateConfigForm(editing.platform, form);

    setFormErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const patch = buildConfigPatch(editing.platform, form, originalForm);

    if (!patch) return closeEdit();

    setIsSaving(true);
    setSaveError(null);
    try {
      const resp = await patchJson(
        `${apiBase}/v1/admin/marketplace/channels/${editing.id}/config`,
        patch,
      );

      if (resp?.channel)
        setChannels((list) =>
          list.map((c) => (c.id === editing.id ? resp.channel : c)),
        );
      setNotice({
        tone: "success",
        text: t("admin-marketplaces-config-saved"),
      });
      closeEdit();
    } catch (err) {
      console.error("Saving channel config failed", err);
      setSaveError(t("admin-marketplaces-config-save-failed"));
    } finally {
      setIsSaving(false);
    }
  };

  const editingFields =
    editing?.platform === "etsy" ? ETSY_FIELDS : EBAY_FIELDS;
  const required = useMemo(
    () =>
      new Set(
        editing && isConnectable(editing.platform)
          ? REQUIRED_FOR_LISTING[editing.platform]
          : [],
      ),
    [editing],
  );
  const stillMissing =
    editing && form && isConnectable(editing.platform)
      ? missingListingFields(editing.platform, form)
      : [];

  // ── Render ──────────────────────────────────────────────────────────────

  const noticeClass = {
    success: "border-success bg-success/10 text-success",
    danger: "border-danger bg-danger/10 text-danger",
    default: "border-default-300 bg-default-100 text-default-700",
  };

  return (
    <DefaultLayout>
      <div className="max-w-6xl mx-auto py-12 px-4 space-y-6">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-3xl font-bold">
              {t("admin-marketplaces-title")}
            </h1>
            <p className="text-sm text-default-500 mt-1">
              {t("admin-marketplaces-description")}
            </p>
          </div>
          <Button variant="primary" onPress={() => setIsConnectOpen(true)}>
            {t("admin-marketplaces-connect-new")}
          </Button>
        </div>

        {notice && (
          <div
            className={`rounded-lg border px-4 py-3 text-sm flex items-start justify-between gap-4 ${noticeClass[notice.tone]}`}
            role="status"
          >
            <span>{notice.text}</span>
            <Button
              size="sm"
              variant="tertiary"
              onPress={() => setNotice(null)}
            >
              {t("admin-marketplaces-dismiss")}
            </Button>
          </div>
        )}

        <Card>
          <Card.Content>
            <Table aria-label={t("admin-marketplaces-title")}>
              <Table.Content>
                <Table.Header>
                  <Table.Column isRowHeader>
                    {t("admin-marketplaces-col-platform")}
                  </Table.Column>
                  <Table.Column>
                    {t("admin-marketplaces-col-shop")}
                  </Table.Column>
                  <Table.Column>{t("admin-common-status")}</Table.Column>
                  <Table.Column>
                    {t("admin-marketplaces-col-listing")}
                  </Table.Column>
                  <Table.Column>
                    {t("admin-marketplaces-col-last-sync")}
                  </Table.Column>
                  <Table.Column>{t("admin-common-actions")}</Table.Column>
                </Table.Header>
                <Table.Body
                  renderEmptyState={() =>
                    isLoading
                      ? t("admin-common-loading")
                      : t("admin-marketplaces-empty")
                  }
                >
                  {channels.map((ch) => {
                    const supported = isConnectable(ch.platform);
                    const active = ch.status === "active";
                    const needsReconnect =
                      supported && (!ch.connected || ch.status === "error");

                    return (
                      <Table.Row key={ch.id} className="odd:bg-default-50">
                        <Table.Cell>
                          <span className="font-medium">
                            {PLATFORM_LABELS[ch.platform] ?? ch.platform}
                          </span>
                          {typeof ch.config.environment === "string" &&
                            ch.config.environment !== "production" && (
                              <span className="ml-2 text-xs text-default-500">
                                ({ch.config.environment})
                              </span>
                            )}
                        </Table.Cell>
                        <Table.Cell>
                          {ch.externalShopId ??
                            (typeof ch.config.marketplace_id === "string"
                              ? ch.config.marketplace_id
                              : "—")}
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex flex-col gap-1 items-start">
                            <StatusBadge
                              colorMap={CHANNEL_STATUS_COLORS}
                              status={ch.status}
                            />
                            {!ch.connected && (
                              <span className="text-xs text-danger">
                                {t("admin-marketplaces-not-connected")}
                              </span>
                            )}
                          </div>
                        </Table.Cell>
                        <Table.Cell>
                          <Chip
                            color={ch.listingReady ? "success" : "warning"}
                            size="sm"
                            variant="soft"
                          >
                            {ch.listingReady
                              ? t("admin-marketplaces-listing-ready")
                              : t("admin-marketplaces-listing-needs-setup")}
                          </Chip>
                        </Table.Cell>
                        <Table.Cell>
                          {ch.lastJob ? (
                            <div className="flex flex-col gap-1 items-start text-xs">
                              <span>
                                {t(
                                  `admin-marketplaces-job-${ch.lastJob.type.replace(/_/g, "-")}`,
                                )}
                              </span>
                              <StatusBadge
                                colorMap={JOB_STATUS_COLORS}
                                status={ch.lastJob.status ?? "pending"}
                              />
                              <span className="text-default-500">
                                {formatServerDate(ch.lastJob.updatedAt)}
                              </span>
                              {ch.lastJob.error && (
                                <span
                                  className="text-danger max-w-[16rem] truncate"
                                  title={ch.lastJob.error}
                                >
                                  {ch.lastJob.error}
                                </span>
                              )}
                            </div>
                          ) : (
                            <span className="text-default-400 text-xs">
                              {t("admin-marketplaces-never-synced")}
                            </span>
                          )}
                        </Table.Cell>
                        <Table.Cell>
                          <div className="flex flex-wrap gap-2">
                            <Button
                              isDisabled={!supported}
                              size="sm"
                              variant="secondary"
                              onPress={() => openEdit(ch)}
                            >
                              {t("admin-marketplaces-edit-config")}
                            </Button>
                            <Button
                              isDisabled={
                                !supported ||
                                !active ||
                                !ch.connected ||
                                busy !== null
                              }
                              size="sm"
                              variant="secondary"
                              onPress={() => pullOrders(ch)}
                            >
                              {busy === `${ch.id}:orders`
                                ? t("admin-marketplaces-syncing")
                                : t("admin-marketplaces-pull-orders")}
                            </Button>
                            <Button
                              isDisabled={
                                !supported || !active || busy !== null
                              }
                              size="sm"
                              variant="tertiary"
                              onPress={() => pushProducts(ch)}
                            >
                              {busy === `${ch.id}:products`
                                ? t("admin-marketplaces-syncing")
                                : t("admin-marketplaces-push-products")}
                            </Button>
                            {needsReconnect && (
                              <Button
                                isDisabled={connecting !== null}
                                size="sm"
                                variant="danger"
                                onPress={() =>
                                  startConnect(
                                    ch.platform as ConnectablePlatform,
                                    ch.id,
                                  )
                                }
                              >
                                {t("admin-marketplaces-reconnect")}
                              </Button>
                            )}
                          </div>
                        </Table.Cell>
                      </Table.Row>
                    );
                  })}
                </Table.Body>
              </Table.Content>
            </Table>
          </Card.Content>
        </Card>

        {/* Connect: choose a platform, then leave for its OAuth consent page. */}
        <Modal
          isOpen={isConnectOpen}
          onOpenChange={(open) => connecting === null && setIsConnectOpen(open)}
        >
          <Modal.Backdrop>
            <Modal.Container size="md">
              <Modal.Dialog>
                {({ close }) => (
                  <>
                    <Modal.CloseTrigger onPress={close} />
                    <Modal.Header>
                      {t("admin-marketplaces-connect-new")}
                    </Modal.Header>
                    <Modal.Body>
                      <p className="text-sm text-default-500 mb-4">
                        {t("admin-marketplaces-connect-help")}
                      </p>
                      <div className="grid grid-cols-2 gap-3">
                        {CONNECTABLE_PLATFORMS.map((p) => (
                          <Button
                            key={p}
                            isDisabled={connecting !== null}
                            variant="secondary"
                            onPress={() => startConnect(p)}
                          >
                            {connecting === p
                              ? t("admin-marketplaces-redirecting")
                              : PLATFORM_LABELS[p]}
                          </Button>
                        ))}
                      </div>
                    </Modal.Body>
                    <Modal.Footer>
                      <Button
                        isDisabled={connecting !== null}
                        variant="tertiary"
                        onPress={close}
                      >
                        {t("admin-common-cancel")}
                      </Button>
                    </Modal.Footer>
                  </>
                )}
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>

        {/* Edit config */}
        <Modal
          isOpen={editing !== null}
          onOpenChange={(open) => !open && !isSaving && closeEdit()}
        >
          <Modal.Backdrop>
            <Modal.Container size="lg">
              <Modal.Dialog>
                {({ close }) => (
                  <>
                    <Modal.CloseTrigger onPress={close} />
                    <Modal.Header>
                      {t("admin-marketplaces-edit-title", {
                        platform: editing
                          ? (PLATFORM_LABELS[editing.platform] ??
                            editing.platform)
                          : "",
                      })}
                    </Modal.Header>
                    <Modal.Body>
                      {form && (
                        <div className="space-y-4">
                          {stillMissing.length > 0 && (
                            <p className="text-sm text-warning">
                              {t("admin-marketplaces-required-note")}
                            </p>
                          )}
                          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                            {editingFields.map((field) => {
                              const value =
                                (form as unknown as Record<string, string>)[
                                  field.key
                                ] ?? "";
                              const error = formErrors[field.key];
                              const set = (v: string) =>
                                setForm({
                                  ...form,
                                  [field.key]: v,
                                } as ConfigForm);
                              const label = `${t(field.labelKey)}${required.has(field.key) ? " *" : ""}`;

                              return (
                                <div
                                  key={field.key}
                                  className="flex flex-col gap-1"
                                >
                                  {field.options ? (
                                    <>
                                      <Label htmlFor={`mp-${field.key}`}>
                                        {label}
                                      </Label>
                                      <select
                                        className={SELECT_CLASS}
                                        id={`mp-${field.key}`}
                                        value={value}
                                        onChange={(e) => set(e.target.value)}
                                      >
                                        {field.options.map((o) => (
                                          <option key={o.value} value={o.value}>
                                            {t(o.labelKey)}
                                          </option>
                                        ))}
                                      </select>
                                    </>
                                  ) : (
                                    <TextField>
                                      <Label>{label}</Label>
                                      <Input
                                        inputMode={
                                          field.numeric ? "numeric" : undefined
                                        }
                                        placeholder={field.placeholder}
                                        value={value}
                                        onChange={(e) => set(e.target.value)}
                                      />
                                    </TextField>
                                  )}
                                  {error ? (
                                    <span className="text-xs text-danger">
                                      {t(error)}
                                    </span>
                                  ) : (
                                    field.hintKey && (
                                      <span className="text-xs text-default-400">
                                        {t(field.hintKey)}
                                      </span>
                                    )
                                  )}
                                </div>
                              );
                            })}
                          </div>
                          {saveError && (
                            <p className="text-sm text-danger">{saveError}</p>
                          )}
                        </div>
                      )}
                    </Modal.Body>
                    <Modal.Footer>
                      <Button
                        isDisabled={isSaving}
                        variant="tertiary"
                        onPress={close}
                      >
                        {t("admin-common-cancel")}
                      </Button>
                      <Button
                        isDisabled={isSaving}
                        variant="primary"
                        onPress={saveConfig}
                      >
                        {isSaving
                          ? t("admin-marketplaces-saving")
                          : t("admin-common-save")}
                      </Button>
                    </Modal.Footer>
                  </>
                )}
              </Modal.Dialog>
            </Modal.Container>
          </Modal.Backdrop>
        </Modal>
      </div>
    </DefaultLayout>
  );
}
