// Line icons from the wireframes' sprite (24-unit grid, round stroke).
import Svg, { Path } from 'react-native-svg';

export const LOCK = 'M7 11h10a2 2 0 0 1 2 2v6a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-6a2 2 0 0 1 2-2zM8 11V7a4 4 0 0 1 8 0v4';
export const FINGERPRINT =
  'M6 9a6.5 6.5 0 0 1 12.5 2c0 3 .2 5-.8 8M9 20c1-2.5 1-5.5 1-8.5a2.3 2.3 0 0 1 4.6 0c0 3.5 0 6-1 9M5 13c0 2-.2 3.5-1 5';
export const BACKSPACE = 'M9 5h11v14H9l-6-7zM12 9.5l5 5M17 9.5l-5 5';
export const LOOP = 'M20 11a8 8 0 0 0-14.5-4M4 4v4h4M4 13a8 8 0 0 0 14.5 4M20 20v-4h-4';
export const STAR = 'M12 2.5l2.9 6.2 6.6.8-4.9 4.6 1.3 6.7-5.9-3.4-5.9 3.4 1.3-6.7-4.9-4.6 6.6-.8z';
export const MIC = 'M9 6a3 3 0 0 1 6 0v5a3 3 0 0 1-6 0zM5 11a7 7 0 0 0 14 0M12 18v3';
export const ADULT =
  'M5.5 6a3 3 0 1 0 6 0a3 3 0 1 0-6 0M3 21v-5a5.5 5.5 0 0 1 9.5-3.7M14.7 12a2.3 2.3 0 1 0 4.6 0a2.3 2.3 0 1 0-4.6 0M13 21v-2.5a4 4 0 0 1 8 0V21';

export function Icon({ d, size, color, fill = 'none' }: { d: string; size: number; color: string; fill?: string }) {
  return (
    <Svg width={size} height={size} viewBox="0 0 24 24" fill={fill} stroke={color} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
      <Path d={d} />
    </Svg>
  );
}
