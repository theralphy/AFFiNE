import { cssVar } from '@toeverything/theme';
import { cssVarV2 } from '@toeverything/theme/v2';
import { style } from '@vanilla-extract/css';

export const content = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
});

export const description = style({
  color: cssVarV2('text/secondary'),
  fontSize: cssVar('fontSm'),
  lineHeight: '22px',
});

export const list = style({
  display: 'flex',
  flexDirection: 'column',
  gap: '2px',
  maxHeight: '280px',
  overflowY: 'auto',
});

export const row = style({
  display: 'flex',
  alignItems: 'center',
  gap: '12px',
  padding: '6px 8px',
  borderRadius: '4px',
  cursor: 'pointer',
  selectors: {
    '&:hover': {
      backgroundColor: cssVarV2('layer/background/hoverOverlay'),
    },
    '&[data-disabled="true"]': {
      cursor: 'default',
      opacity: 0.6,
    },
  },
});

export const info = style({
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  overflow: 'hidden',
});

export const name = style({
  color: cssVarV2('text/primary'),
  fontSize: cssVar('fontSm'),
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

export const email = style({
  color: cssVarV2('text/secondary'),
  fontSize: cssVar('fontXs'),
  whiteSpace: 'nowrap',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
});

export const status = style({
  color: cssVarV2('text/tertiary'),
  fontSize: cssVar('fontXs'),
  flexShrink: 0,
});

export const empty = style({
  color: cssVarV2('text/secondary'),
  fontSize: cssVar('fontSm'),
  padding: '12px 8px',
  textAlign: 'center',
});

export const loadMore = style({
  alignSelf: 'center',
});
