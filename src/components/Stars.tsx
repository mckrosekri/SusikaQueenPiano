import { Star } from 'lucide-react';
export function Stars({ count, large = false }: { count: number; large?: boolean }) {
  return <span className={`earned-stars${large ? ' earned-stars--large' : ''}`} role="img" aria-label={`${count} of 3 stars`}>
    {[1, 2, 3].map((star) => <Star key={star} className={star <= count ? 'is-earned' : ''} fill={star <= count ? 'currentColor' : 'none'} aria-hidden="true" />)}
  </span>;
}
