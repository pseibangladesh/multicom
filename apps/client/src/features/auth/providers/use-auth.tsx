/**
 * @copyright Copyright (c) 2024-2026 Ronan LE MEILLAT
 * @license AGPL-3.0-or-later
 */

import React, { createContext, useContext, ReactNode } from "react";

import { AuthProvider } from "./auth-provider";
import { useLocalProvider } from "./local-provider";

const AuthContext = createContext<AuthProvider | null>(null);

export const AuthProviderWrapper: React.FC<{ children: ReactNode }> = ({
  children,
}) => {
  const authProvider = useLocalProvider();

  return (
    <AuthContext.Provider value={authProvider}>{children}</AuthContext.Provider>
  );
};

export const useAuth = (): AuthProvider => {
  const context = useContext(AuthContext);

  if (!context) {
    throw new Error("useAuth must be used within an AuthProviderWrapper");
  }

  return context;
};
