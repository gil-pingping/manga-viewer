package dev.giyun.mangaviewer;

import static org.junit.Assert.assertFalse;
import static org.junit.Assert.assertTrue;

import org.junit.Test;

public class PageCollectorPluginTest {
    @Test
    public void smallFirstResultScrollsBeforeSuccess() {
        assertTrue(PageCollectorPlugin.shouldScrollBeforeAccepting(0, true));
        assertTrue(PageCollectorPlugin.shouldScrollBeforeAccepting(1, true));
        assertTrue(PageCollectorPlugin.shouldScrollBeforeAccepting(2, true));
        assertFalse(PageCollectorPlugin.shouldScrollBeforeAccepting(3, true));
        assertFalse(PageCollectorPlugin.shouldScrollBeforeAccepting(1, false));
    }
}
