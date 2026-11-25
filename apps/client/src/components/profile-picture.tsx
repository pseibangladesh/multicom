/**
 * Customer profile picture: <UserAvatar> shows it (or the initials), and
 * <ProfilePictureCard> lets the customer upload, change or remove it
 * (POST/DELETE /v1/me/avatar). The picture is the account's `user.image`,
 * so the session refresh after a change updates the header too.
 */
import { useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Avatar, Button, Card } from "@heroui/react";
import { Camera, Trash2 } from "lucide-react";

import { useAuth } from "@/authentication";
import { getApiBase } from "@/lib/api-base";
import {
  type AvatarError,
  checkAvatarFile,
  initialsOf,
  prepareAvatar,
} from "@/lib/avatar";

export function UserAvatar({
  image,
  name,
  email,
  size = "lg",
  className,
}: {
  image?: string | null;
  name?: string | null;
  email?: string | null;
  size?: "sm" | "md" | "lg";
  className?: string;
}) {
  const { t } = useTranslation();

  return (
    <Avatar className={className} size={size}>
      {image && <Avatar.Image alt={t("account-photo-alt")} src={image} />}
      <Avatar.Fallback>{initialsOf(name, email)}</Avatar.Fallback>
    </Avatar>
  );
}

type Status =
  | { kind: "idle" }
  | { kind: "busy" }
  | { kind: "done"; key: "account-photo-saved" | "account-photo-removed" }
  | { kind: "error"; key: string };

const ERROR_KEYS: Record<AvatarError | "upload", string> = {
  type: "account-photo-error-type",
  size: "account-photo-error-size",
  read: "account-photo-error-read",
  upload: "account-photo-error-upload",
};

export function ProfilePictureCard({
  name,
  email,
}: {
  name?: string | null;
  email?: string | null;
}) {
  const { t } = useTranslation();
  // The auth context is untyped at this boundary (see use-auth).
  const auth = useAuth() as any;
  const queryClient = useQueryClient();
  const input = useRef<HTMLInputElement>(null);
  const [status, setStatus] = useState<Status>({ kind: "idle" });
  const image: string | null = auth.user?.image ?? null;
  const busy = status.kind === "busy";

  const afterChange = async (
    key: "account-photo-saved" | "account-photo-removed",
  ) => {
    await auth.refreshSession();
    await queryClient.invalidateQueries({ queryKey: ["me"] });
    setStatus({ kind: "done", key });
  };

  const onFile = async (file: File | undefined) => {
    if (input.current) input.current.value = ""; // allow picking the same file again
    if (!file) return;
    const problem = checkAvatarFile(file);

    if (problem) return setStatus({ kind: "error", key: ERROR_KEYS[problem] });
    setStatus({ kind: "busy" });
    let blob: Blob;

    try {
      blob = await prepareAvatar(file);
    } catch {
      return setStatus({ kind: "error", key: ERROR_KEYS.read });
    }
    try {
      const form = new FormData();

      form.append(
        "file",
        blob,
        blob.type === "image/webp" ? "avatar.webp" : "avatar.jpg",
      );
      await auth.postForm(`${getApiBase()}/v1/me/avatar`, form);
      await afterChange("account-photo-saved");
    } catch {
      setStatus({ kind: "error", key: ERROR_KEYS.upload });
    }
  };

  const remove = async () => {
    setStatus({ kind: "busy" });
    try {
      await auth.deleteJson(`${getApiBase()}/v1/me/avatar`);
      await afterChange("account-photo-removed");
    } catch {
      setStatus({ kind: "error", key: ERROR_KEYS.upload });
    }
  };

  return (
    <Card>
      <Card.Header>
        <h2 className="text-lg font-semibold">{t("account-photo-title")}</h2>
      </Card.Header>
      <Card.Content>
        <div className="flex flex-col items-start gap-4 sm:flex-row sm:items-center">
          <UserAvatar
            className="h-20 w-20 text-xl ring-2 ring-bx-line"
            email={email}
            image={image}
            name={name}
          />
          <div className="min-w-0 space-y-2">
            <p className="text-sm text-bx-stone">{t("account-photo-help")}</p>
            <div className="flex flex-wrap gap-2">
              <input
                ref={input}
                accept="image/*"
                className="sr-only"
                id="profile-picture-input"
                tabIndex={-1}
                type="file"
                onChange={(e) => onFile(e.target.files?.[0])}
              />
              <Button
                isDisabled={busy}
                variant="primary"
                onPress={() => input.current?.click()}
              >
                <Camera aria-hidden className="h-4 w-4" />
                {busy
                  ? t("account-photo-uploading")
                  : image
                    ? t("account-photo-change")
                    : t("account-photo-upload")}
              </Button>
              {image && (
                <Button isDisabled={busy} variant="tertiary" onPress={remove}>
                  <Trash2 aria-hidden className="h-4 w-4" />
                  {t("account-photo-remove")}
                </Button>
              )}
            </div>
            {status.kind === "done" && (
              <p className="text-sm text-bx-accent" role="status">
                {t(status.key)}
              </p>
            )}
            {status.kind === "error" && (
              <p className="text-sm text-danger" role="alert">
                {t(status.key)}
              </p>
            )}
          </div>
        </div>
      </Card.Content>
    </Card>
  );
}
