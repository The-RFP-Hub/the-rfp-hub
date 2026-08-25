/** The publisher path, shown once at the surface level rather than repeated for every listing. */

const STEPS = [
  { id: "submit", label: "Submit" },
  { id: "review", label: "In review" },
  { id: "live", label: "Live" },
] as const;

export type PublisherJourneyStep = (typeof STEPS)[number]["id"];

export function PublisherJourney({
  current,
  reviewSkipped = false,
}: {
  current: PublisherJourneyStep;
  reviewSkipped?: boolean;
}) {
  const currentIndex = STEPS.findIndex((step) => step.id === current);

  return (
    <ol className="publisher-journey" aria-label="Publishing journey">
      {STEPS.map((step, index) => {
        const state =
          step.id === "review" && reviewSkipped
            ? "skipped"
            : index < currentIndex
              ? "complete"
              : index === currentIndex
                ? "current"
                : "upcoming";
        return (
          <li
            key={step.id}
            data-state={state}
            aria-current={state === "current" ? "step" : undefined}
          >
            <span>{step.label}</span>
            {step.id === "review" && reviewSkipped ? (
              <span className="publisher-journey-note">Review not required</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
