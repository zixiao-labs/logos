import { useEffect, useState } from "react";
import { AlertDialog, Button, Checkbox, Description } from "@heroui/react";
import { useT } from "../i18n";
import { notifyError } from "../lib/toast";
import { useStore } from "../state/store";

export function WorkspaceAgentSetupDialog() {
  const t = useT();
  const prompt = useStore((state) => state.workspaceAgentSetup);
  const dismiss = useStore((state) => state.dismissWorkspaceAgentSetup);
  const setup = useStore((state) => state.setupWorkspaceAgents);
  const mcpComplete = prompt ? Object.values(prompt.mcp).every(Boolean) : false;
  const [installMcp, setInstallMcp] = useState(true);
  const [installSkill, setInstallSkill] = useState(true);
  const [installing, setInstalling] = useState(false);

  useEffect(() => {
    if (!prompt) return;
    setInstallMcp(!Object.values(prompt.mcp).every(Boolean));
    setInstallSkill(!prompt.skill);
  }, [prompt]);

  const apply = async () => {
    if (installing) return;
    setInstalling(true);
    try {
      await setup(installMcp, installSkill);
    } catch (error) {
      notifyError(
        t("workspace.agentSetupFailed"),
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      setInstalling(false);
    }
  };

  return (
    <AlertDialog.Backdrop
      isDismissable={false}
      isKeyboardDismissDisabled
      isOpen={Boolean(prompt)}
    >
      <AlertDialog.Container placement="center" size="lg">
        <AlertDialog.Dialog>
          <AlertDialog.Header>
            <AlertDialog.Icon status="accent" />
            <div className="min-w-0">
              <AlertDialog.Heading>{t("workspace.agentSetupTitle")}</AlertDialog.Heading>
              <p className="mt-1 truncate text-sm text-muted" title={prompt?.root}>
                {prompt?.root}
              </p>
            </div>
          </AlertDialog.Header>
          <AlertDialog.Body>
            <p className="mb-5 text-sm leading-6 text-muted">
              {t("workspace.agentSetupBody")}
            </p>
            <div className="grid gap-3">
              <Checkbox
                isDisabled={mcpComplete}
                isSelected={installMcp}
                variant="secondary"
                onChange={setInstallMcp}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="font-medium">{t("workspace.agentSetupMcp")}</span>
                </Checkbox.Content>
                <Description className="ml-7 mt-1 text-xs leading-5 text-muted">
                  {t("workspace.agentSetupMcpDetail")}
                </Description>
              </Checkbox>
              <Checkbox
                isDisabled={Boolean(prompt?.skill)}
                isSelected={installSkill}
                variant="secondary"
                onChange={setInstallSkill}
              >
                <Checkbox.Content>
                  <Checkbox.Control>
                    <Checkbox.Indicator />
                  </Checkbox.Control>
                  <span className="font-medium">{t("workspace.agentSetupSkill")}</span>
                </Checkbox.Content>
                <Description className="ml-7 mt-1 text-xs leading-5 text-muted">
                  {t("workspace.agentSetupSkillDetail")}
                </Description>
              </Checkbox>
            </div>
          </AlertDialog.Body>
          <AlertDialog.Footer>
            <Button isDisabled={installing} variant="tertiary" onPress={dismiss}>
              {t("workspace.agentSetupSkip")}
            </Button>
            <Button
              isDisabled={installing || (!installMcp && !installSkill)}
              variant="primary"
              onPress={() => void apply()}
            >
              {t("workspace.agentSetupApply")}
            </Button>
          </AlertDialog.Footer>
        </AlertDialog.Dialog>
      </AlertDialog.Container>
    </AlertDialog.Backdrop>
  );
}
