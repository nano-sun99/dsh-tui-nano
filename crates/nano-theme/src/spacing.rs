//! Shared spacing tokens and vertical gap roles for Nano's own surfaces.
//!
//! The transcript and the application chrome both draw one-row gaps and
//! two-cell insets. Keeping the numbers and their semantic roles here stops
//! each renderer from inventing its own blank line.

/// Horizontal inset from the terminal edge to the main content or a panel.
pub const EDGE: usize = 2;
/// One level of body/detail indentation.
pub const INDENT: usize = 2;
/// Second-level indentation for nested tool bodies.
pub const NESTED: usize = 4;
/// One cell between two columns of a summary row.
pub const INLINE: usize = 1;
/// One row separating the title, composer, status bar, and dock.
pub const CHROME_GAP: usize = 1;

/// Vertical spacing role between two blocks.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
#[repr(u8)]
pub enum Gap {
    /// Blocks are visually joined (a process summary followed by another).
    None,
    /// A new section inside one entry (reasoning header to answer).
    Section,
    /// A new block or entry.
    Block,
}

impl Gap {
    /// Rows this role writes.
    pub const fn rows(self) -> usize {
        match self {
            Self::None => 0,
            Self::Section | Self::Block => 1,
        }
    }

    /// Rank used to collapse adjacent gaps: the larger role wins.
    const fn rank(self) -> u8 {
        match self {
            Self::None => 0,
            Self::Section => 1,
            Self::Block => 2,
        }
    }

    /// Adjacent margins collapse to the larger role, never sum.
    pub const fn collapse(self, next: Self) -> Self {
        if self.rank() >= next.rank() {
            self
        } else {
            next
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tokens_match_the_validated_rhythm() {
        assert_eq!((EDGE, INDENT, NESTED, INLINE, CHROME_GAP), (2, 2, 4, 1, 1));
    }

    #[test]
    fn gaps_collapse_to_the_larger_role() {
        assert_eq!(Gap::None.collapse(Gap::Section), Gap::Section);
        assert_eq!(Gap::Section.collapse(Gap::Block), Gap::Block);
        assert_eq!(Gap::Block.collapse(Gap::None), Gap::Block);
        assert_eq!(Gap::Block.collapse(Gap::Block), Gap::Block);
    }

    #[test]
    fn only_none_writes_no_rows() {
        assert_eq!(Gap::None.rows(), 0);
        assert_eq!(Gap::Section.rows(), 1);
        assert_eq!(Gap::Block.rows(), 1);
    }
}
