"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import { Sidebar } from "@/components/sidebar/sidebar";
import { Header } from "@/components/layout/header";
import { KBEditor } from "@/components/editor/editor";
import { WebsiteViewer } from "@/components/editor/website-viewer";
import { PdfViewer } from "@/components/editor/pdf-viewer";
import { CsvViewer } from "@/components/editor/csv-viewer";
import { HomeScreen } from "@/components/home/home-screen";
import { AgentsWorkspace } from "@/components/agents/agents-workspace";
import { JobsManager } from "@/components/jobs/jobs-manager";
import { SettingsPage } from "@/components/settings/settings-page";
import { AIPanel } from "@/components/ai-panel/ai-panel";
import { SearchDialog } from "@/components/search/search-dialog";
import { KeyboardShortcuts } from "@/components/shortcuts/keyboard-shortcuts";
import { StatusBar } from "@/components/layout/status-bar";
import { OnboardingWizard } from "@/components/onboarding/onboarding-wizard";
import { NotificationToasts } from "@/components/layout/notification-toasts";
import { useHashRoute } from "@/hooks/use-hash-route";
import { useTreeStore } from "@/stores/tree-store";
import { useAppStore } from "@/stores/app-store";
import type { TreeNode } from "@/types";

function findNode(nodes: TreeNode[], path: string): TreeNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNode(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

export function AppShell() {
  const loadTree = useTreeStore((s) => s.loadTree);
  const nodes = useTreeStore((s) => s.nodes);
  const selectedPath = useTreeStore((s) => s.selectedPath);
  const section = useAppStore((s) => s.section);
  const setSection = useAppStore((s) => s.setSection);
  const sidebarCollapsed = useAppStore((s) => s.sidebarCollapsed);
  const setSidebarCollapsed = useAppStore((s) => s.setSidebarCollapsed);
  const setAiPanelCollapsed = useAppStore((s) => s.setAiPanelCollapsed);
  const aiPanelCollapsed = useAppStore((s) => s.aiPanelCollapsed);
  // Sync navigation state with URL hash + localStorage
  useHashRoute();

  // Onboarding wizard state
  const [showWizard, setShowWizard] = useState<boolean | null>(null);

  useEffect(() => {
    loadTree();
  }, [loadTree]);

  // Auto-refresh sidebar when /data changes (detected via SSE)
  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource("/api/agents/events");
      es.addEventListener("tree_changed", () => loadTree());
      es.addEventListener("conversation_completed", (e) => {
        try {
          const data = JSON.parse(e.data);
          window.dispatchEvent(
            new CustomEvent("cabinet:conversation-completed", { detail: data })
          );
        } catch { /* ignore */ }
      });
    } catch {
      // SSE not supported
    }
    return () => es?.close();
  }, [loadTree]);

  // Check if company config exists (first-time setup)
  useEffect(() => {
    fetch("/api/agents/config")
      .then((r) => r.json())
      .then((data) => setShowWizard(!data.exists))
      .catch(() => setShowWizard(false));
  }, []);

  const handleWizardComplete = useCallback(() => {
    setShowWizard(false);
    setSection({ type: "home" });
    loadTree();
  }, [setSection, loadTree]);

  const selectedNode = selectedPath ? findNode(nodes, selectedPath) : null;
  // For paths not in the tree (e.g. .agents/ workspace files), infer type from extension
  const inferredType = !selectedNode && selectedPath
    ? selectedPath.endsWith(".csv") ? "csv"
    : selectedPath.endsWith(".pdf") ? "pdf"
    : null
    : null;
  const isWebsite = selectedNode?.type === "website";
  const isApp = selectedNode?.type === "app";
  const isPdf = selectedNode?.type === "pdf" || inferredType === "pdf";
  const isCsv = selectedNode?.type === "csv" || inferredType === "csv";
  // Auto-collapse sidebar + AI panel when entering app mode
  const prevIsApp = useRef(false);
  useEffect(() => {
    if (isApp && !prevIsApp.current) {
      setSidebarCollapsed(true);
      setAiPanelCollapsed(true);
    }
    prevIsApp.current = !!isApp;
  }, [isApp, setSidebarCollapsed, setAiPanelCollapsed]);

  const handleExitApp = () => {
    setSidebarCollapsed(false);
    setAiPanelCollapsed(false);
  };

  // Determine what to render in the main area
  const renderContent = () => {
    // System sections (non-page views)
    if (section.type === "home") return <HomeScreen />;
    if (section.type === "settings") return <SettingsPage />;
    if (section.type === "agents") {
      return <AgentsWorkspace selectedScope="all" selectedAgentSlug={null} />;
    }
    if (section.type === "agent") {
      return (
        <AgentsWorkspace
          selectedScope="agent"
          selectedAgentSlug={section.slug || null}
        />
      );
    }
    if (section.type === "jobs") return <JobsManager />;

    // Page-based views (when a KB page is selected)
    if (isApp && selectedNode) {
      return (
        <WebsiteViewer
          path={selectedNode.path}
          title={selectedNode.frontmatter?.title || selectedNode.name}
          fullscreen
          onExit={handleExitApp}
        />
      );
    }
    if (isCsv && (selectedNode || selectedPath)) {
      const csvPath = selectedNode?.path || selectedPath!;
      const csvTitle = selectedNode?.frontmatter?.title || selectedNode?.name || csvPath.split("/").pop() || "CSV";
      return (
        <CsvViewer
          path={csvPath}
          title={csvTitle}
        />
      );
    }
    if (isPdf && (selectedNode || selectedPath)) {
      const pdfPath = selectedNode?.path || selectedPath!;
      const pdfTitle = selectedNode?.frontmatter?.title || selectedNode?.name || pdfPath.split("/").pop() || "PDF";
      return (
        <PdfViewer
          path={pdfPath}
          title={pdfTitle}
        />
      );
    }
    if (isWebsite && selectedNode) {
      return (
        <WebsiteViewer
          path={selectedNode.path}
          title={selectedNode.frontmatter?.title || selectedNode.name}
        />
      );
    }

    // Default: editor
    return (
      <>
        <Header />
        <KBEditor />
      </>
    );
  };

  // Show nothing while checking config
  if (showWizard === null) {
    return <div className="flex h-screen bg-background" />;
  }

  // Show onboarding wizard for first-time users
  if (showWizard) {
    return <OnboardingWizard onComplete={handleWizardComplete} />;
  }

  return (
    <div className="flex h-screen bg-background text-foreground">
      <Sidebar />
      <div
        className="flex-1 flex flex-col overflow-hidden"
        style={{ '--sidebar-toggle-offset': sidebarCollapsed ? '2.25rem' : '0px' } as React.CSSProperties}
      >
        <main className="flex-1 flex flex-col overflow-hidden">
          {renderContent()}
        </main>
        <StatusBar />
      </div>
      {!aiPanelCollapsed && <AIPanel />}
      <SearchDialog />
      <KeyboardShortcuts />
      <NotificationToasts />
    </div>
  );
}
