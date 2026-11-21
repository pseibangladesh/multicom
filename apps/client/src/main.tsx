import React from "react";
import ReactDOM from "react-dom/client";
import { BrowserRouter } from "react-router-dom";

import App from "./app.tsx";
import "./i18n";
import { Provider } from "./provider.tsx";
import { getBaseURL } from "@/utils/base-url";
import "@/styles/globals.css";
import { CookieConsentProvider } from "./contexts/cookie-consent-context.tsx";
import { CookieConsent } from "@/shared/ui/overlays/cookie-consent";
import { AuthenticationProvider } from "./authentication";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const queryClient = new QueryClient();

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
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
  </React.StrictMode>
);
