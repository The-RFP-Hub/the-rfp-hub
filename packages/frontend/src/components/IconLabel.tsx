import type { ComponentType, ReactNode, SVGProps } from "react";

/** A Heroicon component with the SVG props its React package exposes. */
export type HeroIcon = ComponentType<SVGProps<SVGSVGElement>>;

/** A consistently sized decorative icon for places that must keep their text as a direct child. */
export function DecorativeIcon({
  icon: Icon,
  className,
}: {
  icon: HeroIcon;
  className?: string;
}) {
  return (
    <Icon
      aria-hidden="true"
      focusable="false"
      className={["icon-label-icon", className].filter(Boolean).join(" ")}
    />
  );
}

/**
 * Pair a decorative Heroicon with a visible label.
 *
 * Icons reinforce the words in this interface; they never replace them. Keeping the SVG hidden
 * from assistive technology means a button still has one concise name instead of an icon title and
 * a text label competing to describe the same action.
 */
export function IconLabel({
  icon: Icon,
  children,
  iconClassName,
  position = "start",
}: {
  icon: HeroIcon;
  children: ReactNode;
  iconClassName?: string;
  position?: "start" | "end";
}) {
  const icon = <DecorativeIcon icon={Icon} className={iconClassName} />;

  return (
    <span className="icon-label">
      {position === "start" ? icon : null}
      <span className="icon-label-text">{children}</span>
      {position === "end" ? icon : null}
    </span>
  );
}
