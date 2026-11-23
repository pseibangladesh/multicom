/**
 * @copyright Copyright (c) 2024-2026 Ronan LE MEILLAT
 * @license AGPL-3.0-or-later
 */

import { FC } from "react";
import { Button } from "@heroui/react";
import { Tooltip } from "@heroui/react";
import { Link } from "@heroui/react";
import { useTranslation } from "react-i18next";

import { getBaseURL } from "@/utils/base-url";
import { ContentLoading } from "@/shared/ui/feedback/content-loading";

import {
  useAuth,
  getNameWithFallback,
  withAuthentication,
} from "../providers/use-auth";

/**
 * Renders the user's profile name with a tooltip showing their username.
 * @returns The user's name with a tooltip showing their username
 */
export function Profile() {
  const { user } = useAuth();

  // eslint-disable-next-line no-console
  console.log(JSON.stringify(user));

  return (
    <Tooltip>
      <Tooltip.Trigger>
        <span>{user?.name}</span>
      </Tooltip.Trigger>
      <Tooltip.Content>
        {user?.nickname}
      </Tooltip.Content>
    </Tooltip>
  );
}

/**
 * Renders a login button for authentication.
 * Only shows when the user is not authenticated.
 * @param props - Component props
 * @param [props.text] - Custom text for the button. Defaults to localized "log-in" text.
 * @returns Login button or null if user is already authenticated
 */
export const LoginButton: FC<{ text?: string }> = ({ text }) => {
  const { isAuthenticated, login } = useAuth();
  const { t } = useTranslation();

  if (!text) {
    text = t("log-in");
  }

  return (
    !isAuthenticated && (
      <Button
        className="text-sm font-normal text-default-600 bg-default-100"
        type="button"
        onPress={() => login()}
      >
        {text}
      </Button>
    )
  );
};

/**
 * Renders a login link for authentication.
 * Only shows when the user is not authenticated.
 * @param props - Component props
 * @param [props.text] - Custom text for the link. Defaults to localized "log-in" text.
 * @param [props.i18nKey] - Optional i18n key to use instead of the default 'log-in'.
 * @param [props.size] - Size of the Heroui link (sm, md, lg).
 * @returns Login link or null if user is already authenticated
 */
export const LoginLink: FC<{
  text?: string;
  /** i18n key for label; defaults to 'log-in' */
  i18nKey?: string;
  color?:
  | "primary"
  | "foreground"
  | "secondary"
  | "success"
  | "warning"
  | "danger";
  /** heroui size; defaults to 'lg' */
  size?: "sm" | "md" | "lg";
}> = ({ text, i18nKey }) => {
  const { isAuthenticated, login } = useAuth();
  const { t } = useTranslation();

  if (!text) {
    text = t(i18nKey || "log-in");
  }

  if (isAuthenticated) return null;

  return (
    <Link
      onPress={() => {
        login();
      }}
    >
      {text}
    </Link>
  );
};

interface LogoutButtonProps {
  /**
   * Show the button even if the user is not authenticated
   */
  showButtonIfNotAuthenticated?: boolean;
  /**
   * Custom text for the button
   */
  text?: string;
}

/**
 * Renders a logout button for authentication.
 * By default, only shows when the user is authenticated.
 * @param props - Component props
 * @param [props.showButtonIfNotAuthenticated=false] - When true, shows the button even if user is not authenticated
 * @param [props.text] - Custom text for the button. Defaults to localized "log-out-someone" text filled with user name or ID
 * @returns Logout button or null based on authentication status and showButtonIfNotAuthenticated setting
 */
export const LogoutButton: FC<LogoutButtonProps> = ({
  showButtonIfNotAuthenticated = false,
  text,
}) => {
  const { isAuthenticated, logout, user } = useAuth();
  const { t } = useTranslation();

  if (!text) {
    text = t("log-out-someone", {
      name: getNameWithFallback(user),
    });
  }

  return (
    (isAuthenticated || showButtonIfNotAuthenticated) && (
      <Tooltip>
        <Tooltip.Trigger>
          <Button
            className="text-sm font-normal text-default-600 bg-default-100"
            type="button"
            onPress={() => {
              logout({
                logoutParams: {
                  returnTo: new URL(
                    getBaseURL() || "/",
                    window.location.origin,
                  ).toString(),
                },
              });
            }}
          >
            <span>{text}</span>
          </Button>
        </Tooltip.Trigger>
        <Tooltip.Content>
          {`${user?.name || ""}\n${user?.nickname || ""}\n${user?.email || ""}\n${user?.sub || ""} `}
        </Tooltip.Content>
      </Tooltip>
    )
  );
};

interface LogoutLinkProps extends LogoutButtonProps {
  /**
   * Link color
   */
  color?:
  | "primary"
  | "foreground"
  | "secondary"
  | "success"
  | "warning"
  | "danger";
  /** heroui size; defaults to 'lg' */
  size?: "sm" | "md" | "lg";
  /** optional i18n key for logout text (default 'log-out-someone') */
  i18nKey?: string;
} // note: kept for backwards compatibility; use logoutI18nKey in LoginLogoutLink


/**
 * Renders a logout link for authentication.
 * By default, only shows when the user is authenticated.
 * @param props - Component props
 * @param [props.text] - Custom text for the link. Defaults to localized "log-out-someone" text filled with user name or ID
 * @param [props.i18nKey] - Optional i18n key to use instead of the default 'log-out-someone'.
 * @param [props.size] - Size of the Heroui link (sm, md, lg).
 * @returns Logout link or null based on authentication status
 */
export const LogoutLink: FC<LogoutLinkProps & { i18nKey?: string }> = ({
  showButtonIfNotAuthenticated = false,
  text,
  i18nKey,
}) => {
  const { isAuthenticated, logout, user } = useAuth();
  const { t } = useTranslation();

  if (!text) {
    text = t(i18nKey || "log-out-someone", {
      name: getNameWithFallback(user),
    });
  }

  if (!(isAuthenticated || showButtonIfNotAuthenticated)) {
    return null;
  }

  return (
    <Link
      onPress={() => {
        logout({
          logoutParams: {
            returnTo: new URL(
              getBaseURL() || "/",
              window.location.origin,
            ).toString(),
          },
        });
      }}
    >
      {text}
    </Link>
  );
};

/**
 * Conditionally renders either a login or logout button based on authentication status.
 * Provides a convenient way to toggle between auth actions in a single component.
 * @returns Either the LoginButton or LogoutButton component
 */
export const LoginLogoutButton: FC<LogoutButtonProps> = ({
  showButtonIfNotAuthenticated = false,
  text,
}) => {
  const { isAuthenticated } = useAuth();

  return isAuthenticated ? (
    <div className="flex items-center gap-2">
      <LogoutButton
        showButtonIfNotAuthenticated={showButtonIfNotAuthenticated}
        text={text}
      />
    </div>
  ) : (
    <LoginButton />
  );
};

/**
 * Conditionally renders either a login or logout link based on authentication status.
 * Provides a convenient way to toggle between auth actions in a single component.
 * @returns Either the LoginLink or LogoutLink component
 */
export const LoginLogoutLink: FC<{
  showButtonIfNotAuthenticated?: boolean;
  text?: string;
  loginI18nKey?: string;
  logoutI18nKey?: string;
  color?:
  | "primary"
  | "foreground"
  | "secondary"
  | "success"
  | "warning"
  | "danger";
  size?: "sm" | "md" | "lg";
}> = ({
  showButtonIfNotAuthenticated = false,
  text,
  loginI18nKey,
  logoutI18nKey,
  color,
  size,
}) => {
    const { isAuthenticated } = useAuth();

    return isAuthenticated ? (
      <LogoutLink
        color={color}
        showButtonIfNotAuthenticated={showButtonIfNotAuthenticated}
        text={text}
        i18nKey={logoutI18nKey}
        size={size}
      />
    ) : (
      <LoginLink
        color={color}
        text={text}
        i18nKey={loginI18nKey}
        size={size}
      />
    );
  };


/**
 * Higher-order component that protects routes requiring authentication.
 * Redirects unauthenticated users to the login page and shows a loading state during the redirect.
 * @param props - Component props
 * @param props.component - The component to render when the user is authenticated
 * @returns The protected component or loading state
 * @example
 * ```tsx
 * <AuthenticationGuard component={ProtectedDashboard} />
 * ```
 */
export const AuthenticationGuard: FC<{ component: FC }> = ({ component }) => {
  const Component = withAuthentication(component, {
    onRedirecting: () => <ContentLoading />,
  });

  return <Component />;
};

/**
 * Custom hook that provides secured API fetching capabilities
 * @returns Object with methods for secured API operations
 * @example
 * ```tsx
 * const { getJson, postJson, deleteJson, hasPermission, putJson } = useSecuredApi();
 * const data = await getJson('https://api.example.com/data');
 * await postJson('https://api.example.com/data', { key: 'value' });
 * await deleteJson('https://api.example.com/data/1');
 * await putJson('https://api.example.com/data/1', { key: 'newValue' });
 * ```
 */
export const useSecuredApi = () => {
  const { getJson, postJson, postForm, deleteJson, hasPermission, putJson, patchJson } = useAuth();

  return {
    getJson,
    postJson,
    postForm,
    patchJson,
    deleteJson,
    hasPermission,
    putJson,
  };
};
