/**
 * The application tree. main.tsx loads this module with a dynamic import()
 * only after the environment check passes, so that a crash while any of these
 * modules load is caught and shown instead of leaving a blank page.
 */
import type { Root } from "react-dom/client";

import React from "react";
import { BrowserRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import App from "./app.tsx";
import "./i18n";
import { Provider } from "./provider.tsx";
import { CookieConsentProvider } from "./contexts/cookie-consent-context.tsx";
import { AuthenticationProvider } from "./authentication";

import { getBaseURL } from "@/utils/base-url";
import "@/styles/globals.css";
import { CookieConsent } from "@/shared/ui/overlays/cookie-consent";
import { AppErrorBoundary } from "@/shared/ui/feedback/startup-screens";

const queryClient = new QueryClient();

export function renderApp(root: Root) {
  root.render(
    <React.StrictMode>
      {/* Outermost, so a crash in any provider is caught too, not just in <App />. */}
      <AppErrorBoundary>
        <BrowserRouter basename={getBaseURL()}>
          <Provider>
            <CookieConsentProvider>
              <AuthenticationProvider>
                <QueryClientProvider client={queryClient}>
                  <CookieConsent />
                  <App />
                </QueryClientProvider>
              </AuthenticationProvider>
            </CookieConsentProvider>
          </Provider>
        </BrowserRouter>
      </AppErrorBoundary>
    </React.StrictMode>,
  );
}
