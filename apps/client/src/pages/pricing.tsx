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

import { Trans, useTranslation } from "react-i18next";

export default function DocsPage() {
  const { t } = useTranslation();

  return (
    <>
      <section className="py-8 md:py-10">
        <div className="max-w-2xl">
          <h1 className="font-display text-4xl text-bx-ink md:text-5xl">
            <Trans t={t}>pricing</Trans>
          </h1>
        </div>
      </section>
    </>
  );
}
