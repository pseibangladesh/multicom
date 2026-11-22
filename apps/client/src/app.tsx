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
import { Suspense } from "react";

import { PageNotFound } from "./pages/404";
import { AdminGuard, AuthenticationGuard, useAuth } from "./authentication";
import CategoriesPage from "./pages/admin/categories";

import { SiteLoading } from "@/shared/ui/feedback/site-loading";
import IndexPage from "@/pages/index";
import ApiPage from "@/pages/api";
import PricingPage from "@/pages/pricing";
import BlogPage from "@/pages/blog";
import AboutPage from "@/pages/about";
import CmsPage from "@/pages/cms-page";
import UsersAndPermissionsPage from "@/pages/admin/users-and-permissions";
import ProductsPage from "@/pages/admin/products";
import CustomersPage from "@/pages/admin/customers";
import InventoryPage from "@/pages/admin/inventory";
import OrdersPage from "@/pages/admin/orders";
import WebhooksPage from "@/pages/admin/webhooks";
import EmailTemplatesPage from "@/pages/admin/email-templates";
import RegionsPage from "@/pages/admin/regions";
import CurrenciesPage from "@/pages/admin/currencies";
import CountriesPage from "@/pages/admin/countries";
import WarehousesPage from "@/pages/admin/warehouses";
import ShippingRatesPage from "@/pages/admin/shipping-rates";
import ShippingClassesPage from "@/pages/admin/shipping-classes";
import TaxRatesPage from "@/pages/admin/tax-rates";
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
import AnalyticsPage from "@/pages/admin/analytics";
import AdminReviewsPage from "@/pages/admin/reviews";
import PaymentGatewaysPage from "@/pages/admin/payment-gateways";
import MarketplacesPage from "@/pages/admin/marketplaces";
import AdminDashboardPage from "@/pages/admin/index";

function App() {
  const { isLoading } = useAuth();

  if (isLoading) {
    return <SiteLoading />;
  }

  // Gérer les erreurs
  // Note: we no longer block the whole app when the user is unauthenticated.
  // Individual routes that require auth use <AuthenticationGuard> instead.
  // The landing page should be accessible to everyone, otherwise GitHub
  // Pages visitors just see an "authentication error" message.

  return (
    <Suspense fallback={<SiteLoading />}>
      <Routes>
        <Route element={<LoginPage />} path="/login" />
        {/* Storefront shell stays mounted across these routes (header, side menu, footer). */}
        <Route element={<ShellRoute />}>
          <Route element={<IndexPage />} path="/" />
          <Route element={<IndexPage />} path="/products" />
          <Route element={<Navigate replace to="/" />} path="/index-luxury" />
          <Route element={<CartPage />} path="/cart" />
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
                <AdminDashboardPage />
              </AdminGuard>
            }
            path="/admin"
          />
          <Route
            element={
              <AdminGuard>
                <UsersAndPermissionsPage />
              </AdminGuard>
            }
            path="/admin/users"
          />
          <Route
            element={
              <AdminGuard>
                <CategoriesPage />
              </AdminGuard>
            }
            path="/admin/categories"
          />
          <Route
            element={
              <AdminGuard>
                <ProductsPage />
              </AdminGuard>
            }
            path="/admin/products"
          />
          <Route
            element={
              <AdminGuard>
                <CustomersPage />
              </AdminGuard>
            }
            path="/admin/customers"
          />
          <Route
            element={
              <AdminGuard>
                <InventoryPage />
              </AdminGuard>
            }
            path="/admin/inventory"
          />
          <Route
            element={
              <AdminGuard>
                <OrdersPage />
              </AdminGuard>
            }
            path="/admin/orders"
          />
          <Route
            element={
              <AdminGuard>
                <WebhooksPage />
              </AdminGuard>
            }
            path="/admin/webhooks"
          />
          <Route
            element={
              <AdminGuard>
                <EmailTemplatesPage />
              </AdminGuard>
            }
            path="/admin/email-templates"
          />
          <Route
            element={
              <AdminGuard>
                <RegionsPage />
              </AdminGuard>
            }
            path="/admin/regions"
          />
          <Route
            element={
              <AdminGuard>
                <CurrenciesPage />
              </AdminGuard>
            }
            path="/admin/currencies"
          />
          <Route
            element={
              <AdminGuard>
                <CountriesPage />
              </AdminGuard>
            }
            path="/admin/countries"
          />
          <Route
            element={
              <AdminGuard>
                <WarehousesPage />
              </AdminGuard>
            }
            path="/admin/warehouses"
          />
          <Route
            element={
              <AdminGuard>
                <ShippingRatesPage />
              </AdminGuard>
            }
            path="/admin/shipping-rates"
          />
          <Route
            element={
              <AdminGuard>
                <ShippingClassesPage />
              </AdminGuard>
            }
            path="/admin/shipping-classes"
          />
          <Route
            element={
              <AdminGuard>
                <TaxRatesPage />
              </AdminGuard>
            }
            path="/admin/tax-rates"
          />
          <Route
            element={
              <AdminGuard>
                <AnalyticsPage />
              </AdminGuard>
            }
            path="/admin/analytics"
          />
          <Route
            element={
              <AdminGuard>
                <AdminReviewsPage />
              </AdminGuard>
            }
            path="/admin/reviews"
          />
          <Route
            element={
              <AdminGuard>
                <PaymentGatewaysPage />
              </AdminGuard>
            }
            path="/admin/payment-gateways"
          />
          <Route
            element={
              <AdminGuard>
                <MarketplacesPage />
              </AdminGuard>
            }
            path="/admin/marketplaces"
          />
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
