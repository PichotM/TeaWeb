import {Settings, settings} from "tc-shared/settings";
import {LogCategory} from "tc-shared/log";
import * as log from "tc-shared/log";
import * as loader from "tc-loader";
import {createModal} from "tc-shared/ui/elements/Modal";
import {ConnectionProfile, default_profile, find_profile, profiles} from "tc-shared/profiles/ConnectionProfile";
import {KeyCode} from "tc-shared/PPTListener";
import * as i18nc from "tc-shared/i18n/country";
import {spawnSettingsModal} from "tc-shared/ui/modal/ModalSettings";
import {server_connections} from "tc-shared/ui/frames/connection_handlers";
import {icon_cache_loader, IconManager} from "tc-shared/file/Icons";

//FIXME: Move this shit out of this file!
export namespace connection_log {
    //TODO: Save password data
    export type ConnectionData = {
        name: string;

        icon_id: number;
        server_unique_id: string;

        country: string;
        clients_online: number;
        clients_total: number;

        flag_password: boolean;
        password_hash: string;
    }

    export type ConnectionEntry = ConnectionData & {
        address: { hostname: string; port: number },
        total_connection: number;

        first_timestamp: number;
        last_timestamp: number;
    }

    let _history: ConnectionEntry[] = [];
    export function log_connect(address: { hostname: string; port: number }) {
        let entry = _history.find(e => e.address.hostname.toLowerCase() == address.hostname.toLowerCase() && e.address.port == address.port);
        if(!entry) {
            _history.push(entry = {
                last_timestamp: Date.now(),
                first_timestamp: Date.now(),
                address: address,
                clients_online: 0,
                clients_total: 0,
                country: 'unknown',
                name: 'Unknown',
                icon_id: 0,
                server_unique_id: "unknown",
                total_connection: 0,

                flag_password: false,
                password_hash: undefined
            });
        }
        entry.last_timestamp = Date.now();
        entry.total_connection++;
        _save();
    }

    export function update_address_info(address: { hostname: string; port: number }, data: ConnectionData) {
        _history.filter(e => e.address.hostname.toLowerCase() == address.hostname.toLowerCase() && e.address.port == address.port).forEach(e => {
            for(const key of Object.keys(data)) {
                if(typeof(data[key]) !== "undefined") {
                    e[key] = data[key];
                }
            }
        });
        _save();
    }

    export function update_address_password(address: { hostname: string; port: number }, password_hash: string) {
        _history.filter(e => e.address.hostname.toLowerCase() == address.hostname.toLowerCase() && e.address.port == address.port).forEach(e => {
            e.password_hash = password_hash;
        });
        _save();
    }

    function _save() {
        settings.changeGlobal(Settings.KEY_CONNECT_HISTORY, JSON.stringify(_history));
    }

    export function history() : ConnectionEntry[] {
        return _history.sort((a, b) => b.last_timestamp - a.last_timestamp);
    }

    export function delete_entry(address: { hostname: string; port: number }) {
        _history = _history.filter(e => !(e.address.hostname.toLowerCase() == address.hostname.toLowerCase() && e.address.port == address.port));
        _save();
    }

    loader.register_task(loader.Stage.JAVASCRIPT_INITIALIZING, {
        name: 'connection history load',
        priority: 1,
        function: async () => {
            _history = [];
            try {
                _history = JSON.parse(settings.global(Settings.KEY_CONNECT_HISTORY, "[]"));
            } catch(error) {
                log.warn(LogCategory.CLIENT, tr("Failed to load connection history: {}"), error);
            }
        }
    });
}

declare const native_client;
export function spawnConnectModal(options: {
    default_connect_new_tab?: boolean /* default false */
}, defaultHost: { url: string, enforce: boolean} = { url: "ts.TeaSpeak.de", enforce: false}, connect_profile?: { profile: ConnectionProfile, enforce: boolean}) {
    let selected_profile: ConnectionProfile;

    const random_id = (() => {
        const array = new Uint32Array(10);
        window.crypto.getRandomValues(array);
        return array.join("");
    })();

    const modal = createModal({
        header: tr("Connect to a server"),
        body: $("#tmpl_connect").renderTag({
            client: native_client,
            forum_path: "https://forum.teaspeak.de/",
            password_id: random_id,
            multi_tab: !settings.static_global(Settings.KEY_DISABLE_MULTI_SESSION),
            default_connect_new_tab: typeof(options.default_connect_new_tab) === "boolean" && options.default_connect_new_tab
        }),
        footer: () => undefined,
        min_width: "28em"
    });

    modal.htmlTag.find(".modal-body").addClass("modal-connect");

    /* server list toggle */
    {
        const container_last_servers = modal.htmlTag.find(".container-last-servers");
        const button = modal.htmlTag.find(".button-toggle-last-servers");
        const set_show = shown => {
            container_last_servers.toggleClass('shown', shown);
            button.find(".arrow").toggleClass('down', shown).toggleClass('up', !shown);
            settings.changeGlobal(Settings.KEY_CONNECT_SHOW_HISTORY, shown);
        };
        button.on('click', event => {
            set_show(!container_last_servers.hasClass("shown"));
        });
        set_show(settings.static_global(Settings.KEY_CONNECT_SHOW_HISTORY));
    }

    const apply = (header, body, footer) => {
        const container_last_server_body = modal.htmlTag.find(".container-last-servers .table .body");
        const container_empty = container_last_server_body.find(".body-empty");
        let current_connect_data: connection_log.ConnectionEntry;

        const button_connect = footer.find(".button-connect");
        const button_connect_tab = footer.find(".button-connect-new-tab");
        const button_manage = body.find(".button-manage-profiles");

        const input_profile = body.find(".container-select-profile select");
        const input_address = body.find(".container-address input");
        const input_nickname = body.find(".container-nickname input");
        const input_password = body.find(".container-password input");

        let updateFields = (reset_current_data: boolean) => {
            if(reset_current_data) {
                current_connect_data = undefined;
                container_last_server_body.find(".selected").removeClass("selected");
            }

            let address = input_address.val().toString();
            settings.changeGlobal(Settings.KEY_CONNECT_ADDRESS, address);
            let flag_address = !!address.match(Regex.IP_V4) || !!address.match(Regex.IP_V6) || !!address.match(Regex.DOMAIN);

            let nickname = input_nickname.val().toString();
            if(nickname)
                settings.changeGlobal(Settings.KEY_CONNECT_USERNAME, nickname);
            else
                nickname = input_nickname.attr("placeholder") || "";
            let flag_nickname = nickname.length >= 3 && nickname.length <= 32;

            input_address.attr('pattern', flag_address ? null : '^[a]{1000}$').toggleClass('is-invalid', !flag_address);
            input_nickname.attr('pattern', flag_nickname ? null : '^[a]{1000}$').toggleClass('is-invalid', !flag_nickname);

            const flag_disabled = !flag_nickname || !flag_address || !selected_profile || !selected_profile.valid();
            button_connect.prop("disabled", flag_disabled);
            button_connect_tab.prop("disabled", flag_disabled);
        };

        input_address.val(defaultHost.enforce ? defaultHost.url : settings.static_global(Settings.KEY_CONNECT_ADDRESS, defaultHost.url));
        input_address
            .on("keyup", () => updateFields(true))
            .on('keydown', event => {
                if(event.keyCode == KeyCode.KEY_ENTER && !event.shiftKey)
                    button_connect.trigger('click');
            });
        button_manage.on('click', event => {
            const modal = spawnSettingsModal("identity-profiles");
            modal.close_listener.push(() => {
                input_profile.trigger('change');
            });
            return true;
        });

        /* Connect Profiles */
        {
            for(const profile of profiles()) {
                input_profile.append(
                    $.spawn("option").text(profile.profile_name).val(profile.id)
                );
            }

            input_profile.on('change', event => {
                selected_profile = find_profile(input_profile.val() as string) || default_profile();
                {
                    settings.changeGlobal(Settings.KEY_CONNECT_USERNAME, undefined);
                    input_nickname
                        .attr('placeholder', selected_profile.connect_username() || "Another TeaSpeak user")
                        .val("");
                }

                settings.changeGlobal(Settings.KEY_CONNECT_PROFILE, selected_profile.id);
                input_profile.toggleClass("is-invalid", !selected_profile || !selected_profile.valid());
                updateFields(true);
            });
            input_profile.val(connect_profile && connect_profile.profile ?
                connect_profile.profile.id :
                settings.static_global(Settings.KEY_CONNECT_PROFILE, "default")
            ).trigger('change');
        }

        const last_nickname = settings.static_global(Settings.KEY_CONNECT_USERNAME, undefined);
        if(last_nickname) /* restore */
            settings.changeGlobal(Settings.KEY_CONNECT_USERNAME, last_nickname);

        input_nickname.val(last_nickname);
        input_nickname.on("keyup", () => updateFields(true));
        setTimeout(() => updateFields(false), 100);

        const server_address = () => {
            let address = input_address.val().toString();
            if(address.match(Regex.IP_V6) && !address.startsWith("["))
                return "[" + address + "]";
            return address;
        };
        button_connect.on('click', event => {
            modal.close();

            const connection = server_connections.active_connection();
            if(connection) {
                connection.startConnection(
                    current_connect_data ? current_connect_data.address.hostname + ":" + current_connect_data.address.port : server_address(),
                    selected_profile,
                    true,
                    {
                        nickname: input_nickname.val().toString() ||  input_nickname.attr("placeholder"),
                        password: (current_connect_data && current_connect_data.password_hash) ? {password: current_connect_data.password_hash, hashed: true} : {password: input_password.val().toString(), hashed: false}
                    }
                );
            } else {
                button_connect_tab.trigger('click');
            }
        });
        button_connect_tab.on('click', event => {
            modal.close();

            const connection = server_connections.spawn_server_connection();
            server_connections.set_active_connection(connection);
            connection.startConnection(
                current_connect_data ? current_connect_data.address.hostname + ":" + current_connect_data.address.port :  server_address(),
                selected_profile,
                true,
                {
                    nickname: input_nickname.val().toString() ||  input_nickname.attr("placeholder"),
                    password: (current_connect_data && current_connect_data.password_hash) ? {password: current_connect_data.password_hash, hashed: true} : {password: input_password.val().toString(), hashed: false}
                }
            );
        });


        /* connect history show */
        {
            for(const entry of connection_log.history().slice(0, 10)) {
                $.spawn("div").addClass("row").append(
                    $.spawn("div").addClass("column delete").append($.spawn("div").addClass("icon_em client-delete")).on('click', event => {
                        event.preventDefault();

                        const row = $(event.target).parents('.row');
                        row.hide(250, () => {
                            row.detach();
                        });
                        connection_log.delete_entry(entry.address);
                        container_empty.toggle(container_last_server_body.children().length > 1);
                    })
                ).append(
                    $.spawn("div").addClass("column name").append([
                        IconManager.generate_tag(icon_cache_loader.load_icon(entry.icon_id, entry.server_unique_id)),
                        $.spawn("a").text(entry.name)
                    ])
                ).append(
                    $.spawn("div").addClass("column address").text(entry.address.hostname + (entry.address.port != 9987 ? (":" + entry.address.port) : ""))
                ).append(
                    $.spawn("div").addClass("column password").text(entry.flag_password ? tr("Yes") : tr("No"))
                ).append(
                    $.spawn("div").addClass("column country-name").append([
                        $.spawn("div").addClass("country flag-" + entry.country.toLowerCase()),
                        $.spawn("a").text(i18nc.country_name(entry.country, tr("Global")))
                    ])
                ).append(
                    $.spawn("div").addClass("column clients").text(entry.clients_online + "/" + entry.clients_total)
                ).append(
                    $.spawn("div").addClass("column connections").text(entry.total_connection + "")
                ).on('click', event => {
                    if(event.isDefaultPrevented())
                        return;

                    event.preventDefault();
                    current_connect_data = entry;
                    container_last_server_body.find(".selected").removeClass("selected");
                    $(event.target).parent('.row').addClass('selected');

                    input_address.val(entry.address.hostname + (entry.address.port != 9987 ? (":" + entry.address.port) : ""));
                    input_password.val(entry.flag_password && entry.password_hash ? "WolverinDEV Yeahr!" : "").trigger('change');
                }).on('dblclick', event => {
                    current_connect_data = entry;
                    button_connect.trigger('click');
                }).appendTo(container_last_server_body);
                container_empty.toggle(false);
            }
        }
    };
    apply(modal.htmlTag, modal.htmlTag, modal.htmlTag);

    modal.open();
    return;
}

export const Regex = {
    //DOMAIN<:port>
    DOMAIN: /^(localhost|((([a-zA-Z0-9_-]{0,63}\.){0,253})?[a-zA-Z0-9_-]{0,63}\.[a-zA-Z]{2,64}))(|:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[0-5]?[0-9]{1,46}))$/,
    //IP<:port>
    IP_V4: /(^((25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?))(|:(6553[0-5]|655[0-2][0-9]|65[0-4][0-9]{2}|6[0-4][0-9]{3}|[0-5]?[0-9]{1,4}))$/,
    IP_V6: /(([0-9a-fA-F]{1,4}:){7,7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:)|fe80:(:[0-9a-fA-F]{0,4}){0,4}%[0-9a-zA-Z]{1,}|::(ffff(:0{1,4}){0,1}:){0,1}((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])|([0-9a-fA-F]{1,4}:){1,4}:((25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9])\.){3,3}(25[0-5]|(2[0-4]|1{0,1}[0-9]){0,1}[0-9]))/,
    IP: /^(([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])\.){3}([0-9]|[1-9][0-9]|1[0-9]{2}|2[0-4][0-9]|25[0-5])$|^(([a-zA-Z]|[a-zA-Z][a-zA-Z0-9\-]*[a-zA-Z0-9])\.)*([A-Za-z]|[A-Za-z][A-Za-z0-9\-]*[A-Za-z0-9])$|^\s*((([0-9A-Fa-f]{1,4}:){7}([0-9A-Fa-f]{1,4}|:))|(([0-9A-Fa-f]{1,4}:){6}(:[0-9A-Fa-f]{1,4}|((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){5}(((:[0-9A-Fa-f]{1,4}){1,2})|:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3})|:))|(([0-9A-Fa-f]{1,4}:){4}(((:[0-9A-Fa-f]{1,4}){1,3})|((:[0-9A-Fa-f]{1,4})?:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){3}(((:[0-9A-Fa-f]{1,4}){1,4})|((:[0-9A-Fa-f]{1,4}){0,2}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){2}(((:[0-9A-Fa-f]{1,4}){1,5})|((:[0-9A-Fa-f]{1,4}){0,3}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(([0-9A-Fa-f]{1,4}:){1}(((:[0-9A-Fa-f]{1,4}){1,6})|((:[0-9A-Fa-f]{1,4}){0,4}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:))|(:(((:[0-9A-Fa-f]{1,4}){1,7})|((:[0-9A-Fa-f]{1,4}){0,5}:((25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}))|:)))(%.+)?\s*$/,
};