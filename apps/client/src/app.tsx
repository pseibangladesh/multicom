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

import { Navigate, Route, Routes } from "react-router-dom";
import { Suspense, lazy } from "react";

import { PageNotFound } from "./pages/404";
import { AdminGuard, AuthenticationGuard } from "./authentication";

import { ContentLoading } from "@/shared/ui/feedback/content-loading";
import IndexPage from "@/pages/index";
import ApiPage from "@/pages/api";
import PricingPage from "@/pages/pricing";
import BlogPage from "@/pages/blog";
import AboutPage from "@/pages/about";
import CmsPage from "@/pages/cms-page";
import { SwaggerPage } from "@/pages/swagger";
import CartPage from "@/pages/cart";
import ProductPage from "@/pages/product";
import SuccessPage from "@/pages/success";
import OrderPage from "@/pages/order";
import AccountLayout from "@/pages/account/account-layout";
import Dashboard from "@/pages/account/dashboard";
import OrderHistory from "@/pages/account/order-history";
import OrderDetail from "@/pages/account/order-detail";
import Addresses from "@/pages/account/addresses";
import Preferences from "@/pages/account/preferences";
import LoginPage from "@/pages/Login";
import { ShellRoute } from "@/layouts/default";

// Admin code is only downloaded when an admin opens /admin.
const BuyNowPage = lazy(() => import("@/pages/buy-now"));
const CategoriesPage = lazy(() => import("@/pages/admin/categories"));
const UsersAndPermissionsPage = lazy(
  () => import("@/pages/admin/users-and-permissions"),
);
const ProductsPage = lazy(() => import("@/pages/admin/products"));
const CustomersPage = lazy(() => import("@/pages/admin/customers"));
const InventoryPage = lazy(() => import("@/pages/admin/inventory"));
const OrdersPage = lazy(() => import("@/pages/admin/orders"));
const WebhooksPage = lazy(() => import("@/pages/admin/webhooks"));
const EmailTemplatesPage = lazy(() => import("@/pages/admin/email-templates"));
const RegionsPage = lazy(() => import("@/pages/admin/regions"));
const CurrenciesPage = lazy(() => import("@/pages/admin/currencies"));
const CountriesPage = lazy(() => import("@/pages/admin/countries"));
const WarehousesPage = lazy(() => import("@/pages/admin/warehouses"));
const ShippingRatesPage = lazy(() => import("@/pages/admin/shipping-rates"));
const ShippingClassesPage = lazy(
  () => import("@/pages/admin/shipping-classes"),
);
const TaxRatesPage = lazy(() => import("@/pages/admin/tax-rates"));
const AnalyticsPage = lazy(() => import("@/pages/admin/analytics"));
const AdminReviewsPage = lazy(() => import("@/pages/admin/reviews"));
const PaymentGatewaysPage = lazy(
  () => import("@/pages/admin/payment-gateways"),
);
const MarketplacesPage = lazy(() => import("@/pages/admin/marketplaces"));
const AdminDashboardPage = lazy(() => import("@/pages/admin/index"));
const BannersPage = lazy(() => import("@/pages/admin/banners"));
const ApiKeysPage = lazy(() => import("@/pages/admin/api-keys"));
const LanguagesPage = lazy(() => import("@/pages/admin/languages"));
const AdminPagesPage = lazy(() => import("@/pages/admin/pages"));
const SocialLinksPage = lazy(() => import("@/pages/admin/social-links"));
const AiAgentsPage = lazy(() => import("@/pages/admin/ai-agents"));
const AdminLayout = lazy(() => import("@/layouts/admin-layout"));

function App() {
  // No app-wide loading screen: public pages render while the session loads,
  // and protected routes show ContentLoading inside the shell (guards).
  // Gérer les erreurs
  // Note: we no longer block the whole app when the user is unauthenticated.
  // Individual routes that require auth use <AuthenticationGuard> instead.
  // The landing page should be accessible to everyone, otherwise GitHub
  // Pages visitors just see an "authentication error" message.

  return (
    <Suspense fallback={<ContentLoading />}>
      <Routes>
        <Route element={<LoginPage />} path="/login" />
        {/* Storefront shell stays mounted across these routes (header, side menu, footer). */}
        <Route element={<ShellRoute />}>
          <Route element={<IndexPage />} path="/" />
          <Route element={<IndexPage />} path="/products" />
          <Route element={<Navigate replace to="/" />} path="/index-luxury" />
          <Route element={<CartPage />} path="/cart" />
          <Route element={<BuyNowPage />} path="/buy-now" />
          <Route element={<SuccessPage />} path="/success" />
          <Route element={<OrderPage />} path="/order/:id" />
          <Route element={<ProductPage />} path="/product/:id" />
          {/* Customer Account Routes */}
          <Route
            element={<AuthenticationGuard component={AccountLayout} />}
            path="/account"
          >
            <Route index element={<Dashboard />} />
            <Route path="orders" element={<OrderHistory />} />
            <Route path="orders/:number" element={<OrderDetail />} />
            <Route path="addresses" element={<Addresses />} />
            <Route path="preferences" element={<Preferences />} />
          </Route>
          {/* API and Admin Pages */}
          <Route
            element={<AuthenticationGuard component={ApiPage} />}
            path="/api"
          />
          <Route
            element={<AuthenticationGuard component={PricingPage} />}
            path="/pricing"
          />
          <Route
            element={<AuthenticationGuard component={BlogPage} />}
            path="/blog"
          />
          <Route element={<AboutPage />} path="/about" />
          <Route
            element={
              <AdminGuard>
                <AdminLayout />
              </AdminGuard>
            }
            path="/admin"
          >
            <Route index element={<AdminDashboardPage />} />
            <Route element={<UsersAndPermissionsPage />} path="users" />
            <Route element={<CategoriesPage />} path="categories" />
            <Route element={<ProductsPage />} path="products" />
            <Route element={<CustomersPage />} path="customers" />
            <Route element={<InventoryPage />} path="inventory" />
            <Route element={<OrdersPage />} path="orders" />
            <Route element={<WebhooksPage />} path="webhooks" />
            <Route element={<EmailTemplatesPage />} path="email-templates" />
            <Route element={<RegionsPage />} path="regions" />
            <Route element={<CurrenciesPage />} path="currencies" />
            <Route element={<CountriesPage />} path="countries" />
            <Route element={<WarehousesPage />} path="warehouses" />
            <Route element={<ShippingRatesPage />} path="shipping-rates" />
            <Route element={<ShippingClassesPage />} path="shipping-classes" />
            <Route element={<TaxRatesPage />} path="tax-rates" />
            <Route element={<AnalyticsPage />} path="analytics" />
            <Route element={<AdminReviewsPage />} path="reviews" />
            <Route element={<PaymentGatewaysPage />} path="payment-gateways" />
            <Route element={<MarketplacesPage />} path="marketplaces" />
            <Route element={<BannersPage />} path="banners" />
            <Route element={<ApiKeysPage />} path="api-keys" />
            <Route element={<LanguagesPage />} path="languages" />
            <Route element={<AdminPagesPage />} path="pages" />
            <Route element={<SocialLinksPage />} path="social-links" />
            <Route element={<AiAgentsPage />} path="ai-agents" />
          </Route>
          <Route
            element={<AuthenticationGuard component={SwaggerPage} />}
            path="/openapi"
          />
          <Route element={<CmsPage />} path="/pages/:handle" />
        </Route>
        <Route element={<PageNotFound />} path="*" />
      </Routes>
    </Suspense>
  );
}

export default App;
