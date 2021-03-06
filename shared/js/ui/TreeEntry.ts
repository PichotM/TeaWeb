import {Registry} from "tc-shared/events";

export interface ChannelTreeEntryEvents {
    notify_select_state_change: { selected: boolean },
    notify_unread_state_change: { unread: boolean }
}

export class ChannelTreeEntry<Events extends ChannelTreeEntryEvents> {
    readonly events: Registry<Events>;

    protected selected_: boolean = false;
    protected unread_: boolean = false;

    /* called from the channel tree */
    protected onSelect(singleSelect: boolean) {
        if(this.selected_ === true) return;
        this.selected_ = true;

        this.events.fire("notify_select_state_change", { selected: true });
    }

    /* called from the channel tree */
    protected onUnselect() {
        if(this.selected_ === false) return;
        this.selected_ = false;

        this.events.fire("notify_select_state_change", { selected: false });
    }

    isSelected() { return this.selected_; }

    setUnread(flag: boolean) {
        if(this.unread_ === flag) return;
        this.unread_ = flag;

        this.events.fire("notify_unread_state_change", { unread: flag });
    }
    isUnread() { return this.unread_; }
}