import { useUiLanguage } from "../i18n/useUiLanguage";
import type { ComponentProps } from "react";
import { FloatingActionButton } from "./ui/FloatingActionButton.android";
import { ScrollComposeButton } from "./ScrollComposeButton.android";
import type { NewThreadButton as SharedNewThreadButton } from "./NewThreadButton.shared";

export function NewThreadButton(props: ComponentProps<typeof SharedNewThreadButton>) {
  const { text: uiText } = useUiLanguage();
  if (props.extended && props.expanded !== undefined) {
    return <ScrollComposeButton {...props} expanded={props.expanded} />;
  }
  return (
    <FloatingActionButton
      {...props}
      icon="square.and.pencil"
      label={uiText("New thread")}
      tone="primary"
      variant={props.extended ? "extended" : "large"}
    />
  );
}
