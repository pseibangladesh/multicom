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

import { useTranslation } from "react-i18next";

export default function UsersAndPermissionsPage() {
  const { t } = useTranslation();

  return (
    <>
      <section className="flex flex-col gap-6 py-8 md:py-10 px-4">
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold">
              {t("admin-users-page-title")}
            </h1>
            <p className="text-default-500 text-sm mt-1">
              User management is now handled by Better Auth sessions.
              Roles and permissions are enforced server-side via the auth middleware.
            </p>
          </div>
        </div>

        <div className="mt-8 p-6 border border-default-200 rounded-xl bg-default-50">
          <h3 className="text-lg font-semibold mb-4">Authentication Methods</h3>
          <ul className="space-y-2 text-sm text-default-600">
            <li>• Session-based auth via Better Auth (cookie)</li>
            <li>• Admin API keys (sk_ prefix) for service-to-service auth</li>
            <li>• OAuth tokens (64-char hex) for scoped API access</li>
          </ul>
        </div>
      </section>
    </>
  );
}
