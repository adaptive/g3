import { Heart } from "lucide-solid";

export function SponsorLink() {
  return (
    <a
      class="button button-outline"
      href="https://github.com/sponsors/adaptive"
      target="_blank"
      rel="noopener noreferrer"
    >
      <Heart size={16} aria-hidden="true" />
      Sponsor on GitHub
      <span class="visually-hidden"> (opens in a new tab)</span>
    </a>
  );
}
