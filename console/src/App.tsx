import { Navigate, Route, Routes } from "react-router";
import Layout from "./components/Layout";
import ProtectedRoute from "./components/ProtectedRoute";
import Adapters from "./pages/Adapters";
import AppCredentials from "./pages/AppCredentials";
import Businesses from "./pages/Businesses";
import Connections from "./pages/Connections";
import Dashboard from "./pages/Dashboard";
import JobDetail from "./pages/JobDetail";
import Login from "./pages/Login";
import Playground from "./pages/Playground";

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />

      <Route
        element={
          <ProtectedRoute>
            <Layout />
          </ProtectedRoute>
        }
      >
        <Route path="/" element={<Dashboard />} />
        <Route path="/businesses" element={<Businesses />} />
        <Route path="/adapters" element={<Adapters />} />
        <Route path="/adapters/jobs/:id" element={<JobDetail />} />
        <Route path="/connections" element={<Connections />} />
        <Route path="/app-credentials" element={<AppCredentials />} />
        <Route path="/playground" element={<Playground />} />
      </Route>

      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
