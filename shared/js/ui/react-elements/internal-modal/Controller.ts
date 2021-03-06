import {Registry} from "tc-shared/events";
import * as React from "react";
import * as ReactDOM from "react-dom";
import {AbstractModal, ModalController, ModalEvents, ModalOptions, ModalState} from "tc-shared/ui/react-elements/ModalDefinitions";
import {InternalModalRenderer} from "tc-shared/ui/react-elements/internal-modal/Renderer";

export class InternalModalController<InstanceType extends InternalModal = InternalModal> implements ModalController {
    readonly events: Registry<ModalEvents>;
    readonly modalInstance: InstanceType;

    private initializedPromise: Promise<void>;

    private domElement: Element;
    private refModal: React.RefObject<InternalModalRenderer>;
    private modalState_: ModalState = ModalState.HIDDEN;

    constructor(instance: InstanceType) {
        this.modalInstance = instance;
        this.events = new Registry<ModalEvents>();
        this.initialize();
    }

    getOptions(): Readonly<ModalOptions> {
        /* FIXME! */
        return {};
    }

    getEvents(): Registry<ModalEvents> {
        return this.events;
    }

    getState() {
        return this.modalState_;
    }

    private initialize() {
        this.refModal = React.createRef();
        this.domElement = document.createElement("div");

        const element = React.createElement(InternalModalRenderer, {
            ref: this.refModal,
            modal: this.modalInstance,
            onClose: () => this.destroy()
        });
        document.body.appendChild(this.domElement);
        this.initializedPromise = new Promise<void>(resolve => {
            ReactDOM.render(element, this.domElement, () => setTimeout(resolve, 0));
        });

        this.modalInstance["onInitialize"]();
    }

    async show() : Promise<void> {
        await this.initializedPromise;
        if(this.modalState_ === ModalState.DESTROYED)
            throw tr("modal has been destroyed");
        else if(this.modalState_ === ModalState.SHOWN)
            return;

        this.refModal.current?.setState({ show: true });
        this.modalState_ = ModalState.SHOWN;
        this.modalInstance["onOpen"]();
        this.events.fire("open");
    }

    async hide() : Promise<void> {
        await this.initializedPromise;
        if(this.modalState_ === ModalState.DESTROYED)
            throw tr("modal has been destroyed");
        else if(this.modalState_ === ModalState.HIDDEN)
            return;

        this.refModal.current?.setState({ show: false });
        this.modalState_ = ModalState.HIDDEN;
        this.modalInstance["onClose"]();
        this.events.fire("close");

        return new Promise<void>(resolve => setTimeout(resolve, 500));
    }

    destroy() {
        if(this.modalState_ === ModalState.SHOWN) {
            this.hide().then(() => this.destroy());
            return;
        }

        ReactDOM.unmountComponentAtNode(this.domElement);
        this.domElement.remove();

        this.domElement = undefined;
        this.modalState_ = ModalState.DESTROYED;
        this.modalInstance["onDestroy"]();
        this.events.fire("destroy");
    }
}

export abstract class InternalModal extends AbstractModal {}