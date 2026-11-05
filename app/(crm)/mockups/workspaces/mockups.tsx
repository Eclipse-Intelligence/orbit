"use client";

import { CaptureMock } from "./mock-capture";
import { WORKSPACES, type MockState } from "./mock-data";
import { DockOpen } from "./mock-dock";
import { MailMock } from "./mock-mail";
import { NewWorkspaceDialog } from "./mock-new-workspace";
import { BrandMock, TeamMock } from "./mock-settings";
import { MockFrame } from "./mock-shell";

export default function WorkspaceMockups({ state, phone }: { state: MockState; phone: boolean }) {
  const eclipse = WORKSPACES.eclipse;
  const ridgeon = WORKSPACES.ridgeon;

  switch (state) {
    case "A-closed":
    case "A":
      return (
        <MockFrame workspace={eclipse} section="capture" switcherOpen={state === "A"} phoneNav={phone}>
          <CaptureMock workspace={eclipse} />
        </MockFrame>
      );
    case "B":
      return (
        <MockFrame workspace={eclipse} section="capture">
          <CaptureMock workspace={eclipse} />
          <NewWorkspaceDialog />
        </MockFrame>
      );
    case "C":
      return (
        <MockFrame workspace={ridgeon} section="settings">
          <BrandMock workspace={ridgeon} />
        </MockFrame>
      );
    case "C-eclipse":
      return (
        <MockFrame workspace={eclipse} section="settings">
          <BrandMock workspace={eclipse} focusTools />
        </MockFrame>
      );
    case "D-list":
      return (
        <MockFrame workspace={ridgeon} section="mail">
          <MailMock workspace={ridgeon} thread="halden" phoneView="list" />
        </MockFrame>
      );
    case "D":
      return (
        <MockFrame workspace={ridgeon} section="mail">
          <MailMock workspace={ridgeon} thread="halden" phoneView="thread" />
        </MockFrame>
      );
    case "D-elsewhere":
      return (
        <MockFrame workspace={ridgeon} section="mail">
          <MailMock workspace={ridgeon} thread="northwind" phoneView="thread" />
        </MockFrame>
      );
    case "E":
      return (
        <MockFrame workspace={eclipse} section="capture">
          <CaptureMock workspace={eclipse} />
        </MockFrame>
      );
    case "E-mail":
      return (
        <MockFrame workspace={eclipse} section="mail">
          <MailMock workspace={eclipse} thread="fernley" phoneView="thread" filedOpen />
        </MockFrame>
      );
    case "F":
      return (
        <MockFrame workspace={ridgeon} section="mail" dock={false}>
          <MailMock workspace={ridgeon} thread="halden" phoneView="list" />
          <DockOpen workspace={ridgeon} />
        </MockFrame>
      );
    case "G":
      return (
        <MockFrame workspace={ridgeon} section="settings">
          <TeamMock workspace={ridgeon} />
        </MockFrame>
      );
  }
}
