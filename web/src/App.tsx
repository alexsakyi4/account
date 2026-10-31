import { lazy, Suspense, type ReactNode } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { AppShell, LoadingScreen } from './components/AppShell';
import { ErrorState } from './components/ui';
import { SessionProvider, useSession } from './lib/session';

const LoginPage = lazy(() => import('./pages/Auth').then((module) => ({ default: module.LoginPage })));
const RegisterPage = lazy(() => import('./pages/Auth').then((module) => ({ default: module.RegisterPage })));
const ForgotPasswordPage = lazy(() => import('./pages/Auth').then((module) => ({ default: module.ForgotPasswordPage })));
const AcceptInvitePage = lazy(() => import('./pages/Auth').then((module) => ({ default: module.AcceptInvitePage })));
const DashboardPage = lazy(() => import('./pages/Dashboard').then((module) => ({ default: module.DashboardPage })));
const InvoicesPage = lazy(() => import('./pages/Invoices').then((module) => ({ default: module.InvoicesPage })));
const BillsPage = lazy(() => import('./pages/Bills').then((module) => ({ default: module.BillsPage })));
const ExpensesPage = lazy(() => import('./pages/Expenses').then((module) => ({ default: module.ExpensesPage })));
const ContactsPage = lazy(() => import('./pages/Contacts').then((module) => ({ default: module.ContactsPage })));
const BankingPage = lazy(() => import('./pages/Banking').then((module) => ({ default: module.BankingPage })));
const PaymentsPage = lazy(() => import('./pages/Payments').then((module) => ({ default: module.PaymentsPage })));
const JournalPage = lazy(() => import('./pages/Journal').then((module) => ({ default: module.JournalPage })));
const AccountsPage = lazy(() => import('./pages/Accounts').then((module) => ({ default: module.AccountsPage })));
const ReportsPage = lazy(() => import('./pages/Reports').then((module) => ({ default: module.ReportsPage })));
const InventoryPage = lazy(() => import('./pages/Inventory').then((module) => ({ default: module.InventoryPage })));
const PayrollPage = lazy(() => import('./pages/Payroll').then((module) => ({ default: module.PayrollPage })));
const SettingsPage = lazy(() => import('./pages/Settings').then((module) => ({ default: module.SettingsPage })));
const ImportExportPage = lazy(() => import('./pages/ImportExport').then((module) => ({ default: module.ImportExportPage })));
const OnboardingPage = lazy(() => import('./pages/Onboarding').then((module) => ({ default: module.OnboardingPage })));
const AdminPage = lazy(() => import('./pages/Admin').then((module) => ({ default: module.AdminPage })));
const PublicInvoicePage = lazy(() => import('./pages/PublicInvoice').then((module) => ({ default: module.PublicInvoicePage })));
const RecurringPage = lazy(() => import('./pages/Recurring').then((module) => ({ default: module.RecurringPage })));

function Protected({ children }: { children: ReactNode }): React.JSX.Element {
  const { session, loading } = useSession();
  const location = useLocation();
  if (loading) return <LoadingScreen />;
  if (!session) return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  return <>{children}</>;
}

function PublicOnly({ children }: { children: ReactNode }): React.JSX.Element {
  const { session, loading } = useSession();
  if (loading) return <LoadingScreen label="Checking your session…" />;
  if (session) return <Navigate to="/" replace />;
  return <>{children}</>;
}

function Flagged({ flag, children }: { flag: string; children: ReactNode }): React.JSX.Element {
  const { featureEnabled, loading } = useSession();
  if (loading) return <LoadingScreen />;
  if (!featureEnabled(flag)) {
    return (
      <div className="mx-auto max-w-lg py-16">
        <ErrorState message={`The ${flag} module is switched off for this company. An admin can enable it in Settings → Features.`} />
      </div>
    );
  }
  return <>{children}</>;
}

export function App(): React.JSX.Element {
  return (
    <BrowserRouter>
      <SessionProvider>
        <Suspense fallback={<LoadingScreen />}>
          <Routes>
            <Route
              path="/login"
              element={
                <PublicOnly>
                  <LoginPage />
                </PublicOnly>
              }
            />
            <Route
              path="/register"
              element={
                <PublicOnly>
                  <RegisterPage />
                </PublicOnly>
              }
            />
            <Route path="/forgot-password" element={<ForgotPasswordPage />} />
            <Route path="/accept-invite" element={<AcceptInvitePage />} />
            <Route path="/pay/:token" element={<PublicInvoicePage />} />

            <Route
              element={
                <Protected>
                  <AppShell />
                </Protected>
              }
            >
              <Route index element={<DashboardPage />} />
              <Route path="onboarding" element={<OnboardingPage />} />
              <Route path="invoices" element={<InvoicesPage />} />
              <Route path="recurring" element={<RecurringPage />} />
              <Route path="customers" element={<ContactsPage kind="customer" />} />
              <Route path="vendors" element={<ContactsPage kind="vendor" />} />
              <Route path="bills" element={<BillsPage />} />
              <Route path="expenses" element={<ExpensesPage />} />
              <Route path="banking" element={<BankingPage />} />
              <Route path="payments" element={<PaymentsPage />} />
              <Route path="journal" element={<JournalPage />} />
              <Route path="accounts" element={<AccountsPage />} />
              <Route path="reports" element={<ReportsPage />} />
              <Route
                path="inventory"
                element={
                  <Flagged flag="inventory">
                    <InventoryPage />
                  </Flagged>
                }
              />
              <Route
                path="payroll"
                element={
                  <Flagged flag="payroll">
                    <PayrollPage />
                  </Flagged>
                }
              />
              <Route path="settings" element={<SettingsPage />} />
              <Route path="import" element={<ImportExportPage />} />
              <Route path="admin" element={<AdminPage />} />
            </Route>

            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Suspense>
      </SessionProvider>
    </BrowserRouter>
  );
}
