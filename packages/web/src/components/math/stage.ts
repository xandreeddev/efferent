import { html, type Html } from "../../html.js"
import { ID_MATH_CARD } from "../../ids.js"
import type { MathStage } from "../../mathViews.js"
import { oobAttr } from "../oob.js"
import { renderExerciseCard } from "./exerciseCard.js"
import { renderMathError, renderSkeleton } from "./skeleton.js"
import { renderSetupForm } from "./setupForm.js"

/**
 * The one stage slot (`#ef-m-card`) — setup form, skeleton, exercise card, or
 * error banner; exactly one at a time (the product decision: one exercise at a
 * time, no page building). Singleton upsert like every math fragment.
 */
export const renderMathStage = (stage: MathStage, oob?: string): Html =>
  html`<section id="${ID_MATH_CARD}" class="ef-m-stage"${oobAttr(oob)}>${
    stage.kind === "setup"
      ? renderSetupForm(stage.setup)
      : stage.kind === "skeleton"
        ? renderSkeleton(stage.message)
        : stage.kind === "error"
          ? renderMathError(stage.message, stage.detail)
          : renderExerciseCard(stage.exercise)
  }</section>`
