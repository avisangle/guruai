// Line icons from the wireframes' sprite (24-unit grid, round stroke).
import Svg, { Path } from 'react-native-svg';

export const LOCK = 'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V7a4 4 0 0 1 8 0v4';
export const FINGERPRINT =
  'M6 9a6.5 6.5 0 0 1 12.5 2c0 3 .2 5-.8 8M9 20c1-2.5 1-5.5 1-8.5a2.3 2.3 0 0 1 4.6 0c0 3.5 0 6-1 9M5 13c0 2-.2 3.5-1 5';
export const BACKSPACE = 'M9 5h11v14H9l-6-7zM12 9.5l5 5M17 9.5l-5 5';

export function Icon({ d, size, color }: { d: string; size: number; color: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d={d} />
    </Svg>
  );
}
