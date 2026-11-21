/**
 * Copyright (c) 2024-2026 Ronan LE MEILLAT
 * License: AGPL-3.0-or-later
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU Affero General Public License as
 * published by the Free Software Foundation, either version 3 of the
 * License, or (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the
 * GNU Affero General Public License for more details.
 *
 * You should have received a copy of the GNU Affero General Public License
 * along with this program. If not, see <http://www.gnu.org/licenses/>.
 */

/**
 * Root authentication provider component.
 *
 * Uses Better Auth session cookies via /api/auth/* (local provider).
 */

import React from "react";

import { AuthProviderWrapper } from "./providers/use-auth";

// Provider types we support
export type AuthenticationType = "local";

interface AuthenticationProviderProps {
  children: React.ReactNode;
  config?: any;
}

/**
 * Root authentication provider component that sets up the Better Auth
 * session-based authentication.
 */
export const AuthenticationProvider: React.FC<AuthenticationProviderProps> = ({
  children,
}) => {
  return (
    <AuthProviderWrapper>{children}</AuthProviderWrapper>
  );
};
