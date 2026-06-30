---
name: paper-review
description: Review academic papers, manuscripts, preprints, drafts, Zotero items, or Google Docs using a structured scholarly rubric. Use when the user asks for paper review, peer-review style feedback, author-facing revision advice, adversarial critique, or assessment of novelty, soundness, reproducibility, limitations, related work, clarity, or ethics.
---

# Paper Review

Use this skill for rigorous, evidence-backed review of academic papers and research drafts. Treat the output as assistive analysis, not a substitute for human scholarly judgment.

## Confidentiality and Policy Check

Before sending unpublished, submitted, or confidential manuscripts to external services, consider venue and reviewer policies. If the paper may be confidential and the current model/tooling may transmit text to an external provider, pause and ask the user to confirm that AI-assisted review is permitted.

If the user is an official reviewer for a venue, remind them that some venues restrict LLM use or require disclosure. Do not provide a final accept/reject recommendation unless the user explicitly asks and confirms that doing so is allowed.

## Inputs

Accept any of:
- Local PDF/text/Markdown/LaTeX files
- Google Docs
- Zotero items or metadata
- Pasted manuscript text
- Paper title/DOI/arXiv URL plus user-provided scope

When reading a PDF is required and no PDF extraction tool is available, ask the user for text, a PDF-to-text export, or permission to use available local tools.

## Review Modes

Choose the mode that best matches the request. If unclear, default to **author-facing review**.

### Quick Review
A concise assessment of the paper's main contribution, biggest strengths, biggest weaknesses, and top revision priorities.

### Author-Facing Review
Constructive feedback intended to help improve a draft. Emphasize actionable changes and avoid performative harshness.

### Peer-Review Style
A conference/journal-style review with summary, strengths, weaknesses, questions, scores only if requested, and confidence.

### Adversarial Review
Actively search for failure modes, hidden assumptions, causal/identification problems, statistical issues, missing baselines, overclaims, and unsupported conclusions. Still cite evidence and avoid speculation beyond the text.

### Literature/Novelty Check
Use web_search and/or Zotero tools when available and requested/appropriate. Distinguish what is verified from what is inferred.

## Core Rubric

Evaluate the paper on these dimensions, adapting to field and genre:

1. **Summary and Claims**
   - What is the research question?
   - What are the main claims/contributions?
   - What evidence supports each claim?

2. **Significance and Novelty**
   - Is the problem important?
   - What is new relative to known work?
   - Are contributions incremental, synthetic, empirical, methodological, theoretical, or practical?

3. **Technical Soundness**
   - Are methods appropriate for the question?
   - Are assumptions stated and plausible?
   - Are analyses, proofs, experiments, or arguments valid?
   - Are conclusions stronger than the evidence permits?

4. **Evidence, Data, and Evaluation**
   - Are datasets/samples/cases adequate and representative?
   - Are baselines, controls, ablations, comparisons, or counterexamples sufficient?
   - Are metrics justified?
   - Are uncertainties and alternative explanations considered?

5. **Reproducibility and Transparency**
   - Are data, code, prompts, instruments, procedures, and parameters described enough to reproduce?
   - Are preprocessing, exclusions, hyperparameters, statistical choices, and annotation protocols documented?
   - Are materials available or availability constraints explained?

6. **Related Work and Positioning**
   - Does the paper cite and engage the most relevant literature?
   - Does it fairly characterize prior work?
   - Are there obvious missing literatures or competing explanations?

7. **Limitations and Threats to Validity**
   - Internal validity: confounds, leakage, selection effects, measurement problems.
   - External validity: generalization limits, domain shifts, sample restrictions.
   - Construct validity: whether measurements match concepts.
   - Statistical/conclusion validity: power, multiple comparisons, robustness.

8. **Clarity and Organization**
   - Is the argument easy to follow?
   - Are definitions precise?
   - Are figures/tables necessary and readable?
   - Are claims signposted and supported where made?

9. **Ethics, Safety, and Societal Impact**
   - Human subjects, privacy, consent, data governance.
   - Dual-use risks, bias, harms, deployment limitations.
   - Disclosure of AI/tool use when relevant.

10. **Actionability**
   - Which fixes are essential before submission/publication?
   - Which are optional improvements?
   - What concrete edits, experiments, citations, robustness checks, or clarifications should be added?

## Evidence Rules

- Ground every important critique in specific paper sections, quotes, page numbers, equations, tables, figures, or line references when available.
- Separate **observed issues** from **questions** and **speculative risks**.
- Do not invent missing details. Say “not stated in the provided text” when appropriate.
- If using external sources, cite URLs and summarize how each source affects the review.
- Do not over-index on writing style if the scientific issue is substantive.

## Output Templates

### Default Author-Facing Output

```markdown
# Paper Review

## One-paragraph summary

## Overall assessment
- Main strengths:
- Main concerns:
- Best next revision target:

## Major comments
1. **Issue title** — severity: high/medium/low
   - Evidence from paper:
   - Why it matters:
   - Suggested fix:

## Minor comments
- ...

## Reproducibility and transparency

## Related work / novelty notes

## Questions for the authors

## Prioritized revision checklist
1. ...
```

### Peer-Review Style Output

```markdown
# Peer-Review Style Report

## Summary

## Strengths

## Weaknesses

## Detailed comments

## Reproducibility

## Ethics / broader impacts

## Questions for authors

## Recommendation
Only include if requested and policy permits: accept / weak accept / borderline / weak reject / reject.

## Confidence
Low / medium / high, with reason.
```

### Quick Review Output

```markdown
# Quick Paper Review

## What the paper claims

## What works well

## Biggest risks

## Top 5 revision actions
```

## Workflow

1. Identify the paper source and review mode.
2. Check confidentiality/policy constraints if relevant.
3. Read enough of the paper to map argument, methods, evidence, and claims.
4. Extract claims and match them to evidence.
5. Apply the rubric selectively but systematically.
6. If novelty/literature verification is requested, search web/Zotero for primary sources and cite them.
7. Produce an evidence-backed review with prioritized fixes.

## When to Ask Clarifying Questions

Ask before proceeding if:
- The target paper/source is ambiguous.
- The user wants review of confidential material and policy/permission is unclear.
- The desired mode is unclear and the stakes are high.
- The user asks for venue-specific scoring but does not specify the venue/rubric.

Otherwise proceed with a reasonable default and state assumptions.
