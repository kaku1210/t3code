import {
  CircleCheckIcon,
  CircleMinusIcon,
  Loader2Icon,
  PowerIcon,
  RotateCwIcon,
  TriangleAlertIcon,
} from "lucide-react";

import { useUiLanguage } from "~/i18n/useUiLanguage";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl } from "./ComposerControl";
import { composerFloatingLayerProps } from "./composerEventScope";
import type { PromptSuggestionState } from "@t3tools/client-runtime/state/prompt-suggestions";

/** A fixed composer slot: unavailable states remain focusable so their reasons stay discoverable. */
export function PromptSuggestionControl({
  state,
  onRegenerate,
}: {
  state: PromptSuggestionState;
  onRegenerate: (() => void) | null;
}) {
  const { t } = useUiLanguage();
  const emptyReason = state.status === "empty" ? state.reason : undefined;
  const failed = state.status === "failed" || emptyReason === "invalid-suggestion";
  const blocked =
    (state.status === "failed" && !state.retryable) ||
    (state.status === "empty" &&
      emptyReason !== undefined &&
      !["no-next-step", "turn-not-ready", "invalid-suggestion"].includes(emptyReason));
  const unavailable = state.status === "unavailable" || emptyReason === "turn-not-ready";
  const status = blocked
    ? "blocked"
    : failed
      ? "failed"
      : unavailable
        ? "unavailable"
        : state.status === "empty"
          ? "empty"
          : state.status;
  const Icon = blocked
    ? TriangleAlertIcon
    : failed
      ? RotateCwIcon
      : state.status === "generating"
        ? Loader2Icon
        : state.status === "ready"
          ? CircleCheckIcon
          : state.status === "empty"
            ? CircleMinusIcon
            : state.status === "unavailable" && state.reason === "off"
              ? PowerIcon
              : RotateCwIcon;
  const title =
    state.status === "unavailable"
      ? t(`composer.promptSuggestionUnavailable.${state.reason}`)
      : state.status === "generating"
        ? t("composer.promptSuggestionGenerating")
        : state.status === "ready"
          ? t("composer.promptSuggestionReady")
          : state.status === "failed"
            ? t(blocked ? "composer.promptSuggestionBlocked" : "composer.promptSuggestionFailed")
            : t(
                emptyReason
                  ? `composer.promptSuggestionEmpty.${emptyReason}`
                  : "composer.promptSuggestionEmpty",
              );

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            aria-label={title}
            aria-disabled={onRegenerate === null}
            data-testid="composer-prompt-suggestion-control"
            data-state={status}
            className="size-7 p-0"
            onClick={() => onRegenerate?.()}
          >
            <Icon
              aria-hidden="true"
              className={cn(
                "size-4",
                unavailable && "opacity-40",
                blocked
                  ? "text-warning"
                  : failed
                    ? "text-destructive"
                    : state.status === "ready"
                      ? "text-success"
                      : "",
                state.status === "generating" && "animate-spin motion-reduce:animate-none",
              )}
            />
          </ComposerControl>
        }
      />
      <TooltipPopup {...composerFloatingLayerProps} side="top" align="end">
        <div className="space-y-1 py-1 text-left">
          <p className="font-medium" role="status">
            {title}
          </p>
          {state.status === "failed" && state.detail ? (
            <p className="whitespace-pre-wrap text-muted-foreground">{state.detail}</p>
          ) : null}
          {state.status === "ready" ? (
            <p className="line-clamp-3 text-muted-foreground">{state.suggestion}</p>
          ) : null}
          {onRegenerate !== null ? (
            <p>
              {t(
                state.status === "ready"
                  ? "composer.promptSuggestionRegenerate"
                  : "composer.promptSuggestionRetryAction",
              )}
            </p>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}
